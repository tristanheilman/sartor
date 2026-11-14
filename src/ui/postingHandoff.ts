/**
 * Receiving a posting the extension captured.
 *
 * The extension can reach only the tab the user clicked (`activeTab`), and
 * there is no server to relay through, so a captured posting travels as a URL
 * fragment on a freshly opened Sartor tab — `#posting=<url-encoded JSON>`,
 * which a GitHub Pages server never sees because fragments never leave the
 * browser. From there a same-origin `BroadcastChannel` hands it to a Sartor
 * tab that is already open, because that is the tab with a model key already
 * sitting in `sessionStorage`; a freshly opened tab has none.
 */
import type { JobDescription } from '../index';

export const POSTING_CHANNEL_NAME = 'sartor-posting';

/** Comfortably larger than any real posting, small enough to reject garbage
 * before it reaches `decodeURIComponent` or `JSON.parse`. The extension
 * checks a posting against this same cap before it ever opens a tab, so a
 * long posting degrades to the paste badge instead of an empty posting box. */
export const MAX_FRAGMENT_LENGTH = 100_000;

type PostingMessage = { type: 'posting'; jd: JobDescription } | { type: 'ack' };

/** Parses and validates `#posting=<url-encoded JSON>`. Returns `null` for
 * anything that is not a well-formed posting, rather than throwing — a
 * malformed fragment should fall through to the normal paste flow. */
export function parsePostingFragment(hash: string): JobDescription | null {
  const match = /^#posting=(.*)$/.exec(hash);
  if (!match) return null;

  const encoded = match[1]!;
  if (encoded.length === 0 || encoded.length > MAX_FRAGMENT_LENGTH) return null;

  let json: string;
  try {
    json = decodeURIComponent(encoded);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  return validatePosting(parsed);
}

/** The same shape and field checks the fragment parser applies, reused for
 * postings arriving over the `BroadcastChannel` — those come from this app's
 * own other tab today, but should not be trusted any more than the fragment
 * is. */
function validatePosting(parsed: unknown): JobDescription | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.text !== 'string' || raw.text.trim().length === 0) return null;
  if (raw.text.length > MAX_FRAGMENT_LENGTH) return null;

  const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

  return {
    title: asString(raw.title),
    company: asString(raw.company),
    location: asString(raw.location),
    url: asString(raw.url),
    text: raw.text,
    source: 'extension',
  };
}

export interface PostingChannel {
  /** Broadcasts `jd` and resolves `true` iff another tab's channel acked it
   * within `timeoutMs`. */
  send(jd: JobDescription, timeoutMs?: number): Promise<boolean>;
  /** Called when another tab broadcasts a posting; it is acked automatically. */
  onPosting(handler: (jd: JobDescription) => void): void;
  close(): void;
}

/**
 * One `BroadcastChannel` per tab, used for both directions. A single instance
 * matters: `BroadcastChannel` never delivers a tab's own message back to
 * itself, but it does deliver to every *other* instance of the same channel
 * name — including a second instance opened by the same tab. Keeping sender
 * and listener on one instance is what stops a tab from acking its own
 * handoff.
 */
export function openPostingChannel(): PostingChannel {
  const channel = new BroadcastChannel(POSTING_CHANNEL_NAME);
  let handler: ((jd: JobDescription) => void) | null = null;
  let onAck: (() => void) | null = null;

  channel.onmessage = (event: MessageEvent<PostingMessage>) => {
    if (event.data.type === 'ack') {
      onAck?.();
    } else {
      const jd = validatePosting(event.data.jd);
      channel.postMessage({ type: 'ack' } satisfies PostingMessage);
      if (jd) handler?.(jd);
    }
  };

  return {
    send(jd, timeoutMs = 300) {
      return new Promise((resolve) => {
        let settled = false;
        onAck = () => {
          if (settled) return;
          settled = true;
          onAck = null;
          resolve(true);
        };
        channel.postMessage({ type: 'posting', jd } satisfies PostingMessage);
        setTimeout(() => {
          if (settled) return;
          settled = true;
          onAck = null;
          resolve(false);
        }, timeoutMs);
      });
    },
    onPosting(h) {
      handler = h;
    },
    close() {
      channel.close();
    },
  };
}
