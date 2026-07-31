import { htmlToText, normalizeText, type JobDescription } from './normalize';

/**
 * Public ATS job-board endpoints.
 *
 * Greenhouse, Lever and Ashby all publish structured JSON for their job boards.
 * Where a pasted URL matches one of them we can fetch the posting directly —
 * no scraping, no proxy, no cost, and a far cleaner result than reading a
 * rendered page. Between them these three cover a large share of tech postings.
 *
 * Deliberately absent: a server-side scraping proxy. It would put bandwidth
 * cost and legal exposure back on whoever operates a deployment, break the
 * zero-infrastructure claim that the whole privacy argument rests on, and still
 * lose to Cloudflare on the sites that matter most. For LinkedIn, Indeed and
 * Workday the right answer is the browser extension (see `extension/`), where
 * the user has already loaded the page themselves.
 *
 * CORS caveat: these endpoints are public but do not all send permissive CORS
 * headers, and their behaviour changes without notice. Every fetch here is
 * therefore best-effort — on failure we say so plainly and fall back to paste,
 * which always works.
 */

export type AtsVendor = 'greenhouse' | 'lever' | 'ashby';

export interface AtsTarget {
  vendor: AtsVendor;
  board: string;
  jobId: string;
  apiUrl: string;
}

/** Recognises a job-posting URL and derives its JSON endpoint. */
export function detectAts(rawUrl: string): AtsTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);

  // https://boards.greenhouse.io/<board>/jobs/<id>
  // https://job-boards.greenhouse.io/<board>/jobs/<id>
  if (host.endsWith('greenhouse.io')) {
    const board = parts[0];
    const jobId = parts[parts.indexOf('jobs') + 1];
    if (board && jobId && parts.includes('jobs')) {
      return {
        vendor: 'greenhouse',
        board,
        jobId,
        apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`,
      };
    }
    return null;
  }

  // https://jobs.lever.co/<board>/<uuid>
  if (host.endsWith('lever.co')) {
    const board = parts[0];
    const jobId = parts[1];
    if (board && jobId) {
      return {
        vendor: 'lever',
        board,
        jobId,
        apiUrl: `https://api.lever.co/v0/postings/${board}/${jobId}`,
      };
    }
    return null;
  }

  // https://jobs.ashbyhq.com/<board>/<uuid>
  if (host.endsWith('ashbyhq.com')) {
    const board = parts[0];
    const jobId = parts[1];
    if (board && jobId) {
      return {
        vendor: 'ashby',
        board,
        jobId,
        // Ashby exposes the whole board; the individual posting is selected
        // from the response below.
        apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
      };
    }
    return null;
  }

  return null;
}

export class AtsFetchError extends Error {
  constructor(
    message: string,
    readonly vendor: AtsVendor,
    readonly likelyCors: boolean,
  ) {
    super(message);
    this.name = 'AtsFetchError';
  }
}

/**
 * Fetches a posting from its ATS. Throws `AtsFetchError` on any failure; the
 * caller is expected to fall back to paste and tell the user why.
 */
export async function fetchFromAts(target: AtsTarget, signal?: AbortSignal): Promise<JobDescription> {
  let res: Response;
  try {
    res = await fetch(target.apiUrl, { signal, headers: { accept: 'application/json' } });
  } catch (err) {
    // A network-level throw from `fetch` on a public URL is, in practice,
    // almost always the browser blocking the response for CORS.
    throw new AtsFetchError(
      `The browser blocked the request to ${target.vendor}. This is a CORS restriction on their side, not a problem with the posting.`,
      target.vendor,
      true,
    );
  }

  if (!res.ok) {
    throw new AtsFetchError(
      `${target.vendor} returned ${res.status} for that posting.`,
      target.vendor,
      false,
    );
  }

  const data: unknown = await res.json();

  switch (target.vendor) {
    case 'greenhouse':
      return parseGreenhouse(data, target);
    case 'lever':
      return parseLever(data, target);
    case 'ashby':
      return parseAshby(data, target);
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function parseGreenhouse(data: unknown, target: AtsTarget): JobDescription {
  const d = data as Record<string, unknown>;
  const location = (d.location as Record<string, unknown> | undefined)?.name;
  return {
    title: str(d.title),
    company: target.board,
    location: str(location),
    url: str(d.absolute_url),
    text: normalizeText(htmlToText(str(d.content))),
    source: 'greenhouse',
  };
}

function parseLever(data: unknown, target: AtsTarget): JobDescription {
  const d = data as Record<string, unknown>;
  const categories = d.categories as Record<string, unknown> | undefined;
  const lists = Array.isArray(d.lists) ? (d.lists as Array<Record<string, unknown>>) : [];
  const listText = lists
    .map((l) => `\n${str(l.text)}\n${htmlToText(str(l.content))}`)
    .join('\n');

  return {
    title: str(d.text),
    company: target.board,
    location: str(categories?.location),
    url: str(d.hostedUrl),
    text: normalizeText(
      [htmlToText(str(d.descriptionPlain) || str(d.description)), listText, htmlToText(str(d.additionalPlain))]
        .filter(Boolean)
        .join('\n\n'),
    ),
    source: 'lever',
  };
}

function parseAshby(data: unknown, target: AtsTarget): JobDescription {
  const jobs = (data as { jobs?: Array<Record<string, unknown>> }).jobs ?? [];
  const job =
    jobs.find((j) => str(j.id) === target.jobId) ??
    jobs.find((j) => str(j.jobUrl).includes(target.jobId));

  if (!job) {
    throw new AtsFetchError(
      'That posting is no longer listed on the Ashby board.',
      'ashby',
      false,
    );
  }

  return {
    title: str(job.title),
    company: target.board,
    location: str(job.location),
    url: str(job.jobUrl),
    text: normalizeText(str(job.descriptionPlain) || htmlToText(str(job.descriptionHtml))),
    source: 'ashby',
  };
}
