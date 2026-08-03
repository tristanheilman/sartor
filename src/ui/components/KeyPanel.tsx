import { useEffect, useState } from 'react';
import { useStore, useActiveProvider } from '../store';
import { maskKey } from '../../storage/keys';

/** How long a deliberate reveal stays on screen before hiding itself. */
const PEEK_SECONDS = 10;

/**
 * Key entry.
 *
 * Everything about where the key goes and what it is used for is stated here,
 * at the point of entry, rather than in a privacy policy nobody opens.
 */
export function KeyPanel() {
  const { settings, updateSettings, apiKey, saveKey, forgetKey } = useStore();
  // Shown only while deliberately asked for, and not for long: the reason it
  // is masked by default is screenshots and shoulders, and both of those are
  // just as true ten seconds later.
  const [peeking, setPeeking] = useState(false);
  const [countdown, setCountdown] = useState(PEEK_SECONDS);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);

  useEffect(() => {
    if (!peeking) {
      setCountdown(PEEK_SECONDS);
      return;
    }
    const id = setInterval(() => {
      setCountdown((n) => {
        if (n <= 1) {
          setPeeking(false);
          return PEEK_SECONDS;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [peeking]);

  // Any key change closes the reveal, so a new key is never shown by accident.
  useEffect(() => setPeeking(false), [apiKey]);

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  async function copy() {
    if (!apiKey) return;
    try {
      // Undefined on a plain-HTTP origin, which is exactly how this gets
      // opened from a phone on the local network. Say so rather than failing
      // silently — "Show" still works there.
      if (!navigator.clipboard) throw new Error('no clipboard on an insecure origin');
      await navigator.clipboard.writeText(apiKey);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }

  const { provider, all } = useActiveProvider();
  const [draft, setDraft] = useState('');

  const prefixMismatch =
    draft.trim().length > 0 &&
    provider.info.keyPrefix !== undefined &&
    !draft.trim().startsWith(provider.info.keyPrefix);

  return (
    <div className="card p-4">
      <h2 className="text-sm font-semibold">Model provider</h2>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="provider">
            Provider
          </label>
          <select
            id="provider"
            className="field"
            value={settings.providerId}
            onChange={(e) => {
              const next = all.find((p) => p.info.id === e.target.value)!;
              void updateSettings({ providerId: next.info.id, model: next.info.defaultModel });
            }}
          >
            {all.map((p) => (
              <option key={p.info.id} value={p.info.id}>
                {p.info.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="label" htmlFor="model">
            Model
          </label>
          <select
            id="model"
            className="field"
            value={settings.model}
            onChange={(e) => void updateSettings({ model: e.target.value })}
          >
            {provider.info.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.note ? ` — ${m.note}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {apiKey ? (
        <div className="mt-4 rounded-md bg-emerald-50 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-emerald-900">Key loaded</span>
            <code className="rounded bg-white px-1.5 py-0.5 font-mono text-xs break-all">
              {peeking ? apiKey : maskKey(apiKey)}
            </code>

            <button
              type="button"
              onClick={() => setPeeking((v) => !v)}
              aria-pressed={peeking}
              aria-label={peeking ? 'Hide key' : 'Show key'}
              title={peeking ? 'Hide key' : 'Show key'}
              className="rounded p-1 text-emerald-800/70 transition-colors hover:bg-white/70 hover:text-emerald-900"
            >
              {peeking ? <EyeOffIcon /> : <EyeIcon />}
            </button>

            {/* Copying never renders the key, which is what the button is
                actually for: getting it back out before clearing it. */}
            <button
              type="button"
              onClick={() => void copy()}
              aria-label="Copy key"
              title="Copy key"
              className="rounded p-1 text-emerald-800/70 transition-colors hover:bg-white/70 hover:text-emerald-900"
            >
              <CopyIcon />
            </button>

            {copied && (
              <span className="text-xs text-emerald-800">
                {copied === 'ok' ? 'Copied' : 'Copy needs a secure page — use Show'}
              </span>
            )}
            {peeking && !copied && <span className="text-xs text-emerald-800/80">{countdown}s</span>}

            <button type="button" className="btn-ghost ml-auto text-xs" onClick={forgetKey}>
              Forget key
            </button>
          </div>
        </div>
      ) : (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) {
              saveKey(draft);
              setDraft('');
            }
          }}
        >
          <label className="label" htmlFor="apikey">
            {provider.info.label} API key
          </label>
          <div className="flex gap-2">
            <input
              id="apikey"
              className="field font-mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={provider.info.keyPrefix ? `${provider.info.keyPrefix}…` : 'Paste your key'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="btn-primary" disabled={!draft.trim()}>
              Use key
            </button>
          </div>
          {prefixMismatch ? (
            <p className="mt-1.5 text-xs text-amber-700">
              That does not look like a {provider.info.label} key — they usually start with{' '}
              <code>{provider.info.keyPrefix}</code>. You can still try it.
            </p>
          ) : null}
          <p className="mt-1.5 text-xs text-stone-500">
            Need one?{' '}
            <a
              className="underline"
              href={provider.info.keyUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Create a key at {provider.info.label}
            </a>
            .
          </p>
        </form>
      )}

      <details className="mt-4 text-xs text-stone-600">
        <summary className="cursor-pointer font-medium text-stone-700">
          Exactly where this key goes
        </summary>
        <ul className="mt-2 space-y-1.5 pl-4">
          <li className="list-disc">
            It is held in this tab's <code>sessionStorage</code>. Closing the tab erases it.
          </li>
          <li className="list-disc">
            It is never written to disk, never put in IndexedDB or a cookie, and never included in
            an export.
          </li>
          <li className="list-disc">
            It is sent to exactly one place: <code>{new URL(provider.info.keyUrl).host}</code>'s API,
            directly from your browser. There is no server in between, because this app does not
            have one.
          </li>
          <li className="list-disc">
            <strong>The honest caveat:</strong> {provider.info.browserNote} A key in a browser can be
            read by any script on the page. This app loads no third-party scripts, fonts, or
            analytics — but you should scope the key narrowly and revoke it when you are done.
          </li>
        </ul>
      </details>
    </div>
  );
}

/* Small enough to sit inline with the key itself. `currentColor` so they take
   the surrounding text colour and its hover state. */
const iconProps = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function EyeIcon() {
  return (
    <svg {...iconProps}>
      <path d="M1.8 12S5.4 5.4 12 5.4 22.2 12 22.2 12 18.6 18.6 12 18.6 1.8 12 1.8 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg {...iconProps}>
      <path d="M9.9 5.6A9.6 9.6 0 0 1 12 5.4c6.6 0 10.2 6.6 10.2 6.6a17.6 17.6 0 0 1-2.9 3.9M6.2 6.2A17.6 17.6 0 0 0 1.8 12s3.6 6.6 10.2 6.6a9.5 9.5 0 0 0 4-.85" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M2.4 2.4l19.2 19.2" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg {...iconProps}>
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M5.5 15H4.5a2 2 0 0 1-2-2V4.5a2 2 0 0 1 2-2H13a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
