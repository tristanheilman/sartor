/**
 * Read-only client for api.github.com.
 *
 * `api.github.com` sends `access-control-allow-origin: *`, so the browser can
 * call it directly — the same reasoning as `jd/ats.ts`. This module only
 * *reads*: it takes a token as a plain argument and never persists it. Where
 * the token comes from, and what scope it should be asked for, are reserved
 * decisions (`storage/keys.ts`, not touched here); see Part 2 of
 * `docs/CONTENT-SOURCES.md` for the full design, including the data-
 * minimisation ladder tiers 1-4 implement.
 *
 * `RepoEvidence` deliberately separates *what we read* from *what we ask the
 * model* — proposing profile content from this evidence is a later module
 * (`propose.ts`) that has not been built yet.
 */

const API_ROOT = 'https://api.github.com';

/** Cuts the README well below typical prompt budgets while keeping the intro. */
const README_BYTE_CAP = 8_000;

const MANIFEST_CANDIDATES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'] as const;

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly kind: 'auth' | 'rate-limit' | 'not-found' | 'network' = 'network',
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RepoSummary {
  name: string;
  fullName: string;
  description: string | null;
  visibility: string;
  pushedAt: string | null;
  url: string;
}

export interface ListReposOptions {
  signal?: AbortSignal;
}

/** Fetches every repo the token's owner owns, following pagination to the end. */
export async function listRepos(token: string, opts: ListReposOptions = {}): Promise<RepoSummary[]> {
  const repos: RepoSummary[] = [];
  let url: string | null = `${API_ROOT}/user/repos?affiliation=owner&per_page=100`;

  while (url) {
    const res = await githubFetch(url, token, opts.signal);
    const data = (await res.json()) as Record<string, unknown>[];
    for (const r of data) {
      repos.push({
        name: str(r.name),
        fullName: str(r.full_name),
        description: (r.description as string | null) ?? null,
        visibility: str(r.visibility),
        pushedAt: (r.pushed_at as string | null) ?? null,
        url: str(r.html_url),
      });
    }
    url = parseLinkHeader(res.headers.get('link')).next ?? null;
  }

  return repos;
}

/** The data-minimisation ladder from `docs/CONTENT-SOURCES.md`. Each tier is opt-in. */
export type EvidenceTier = 1 | 2 | 3 | 4;

/** A single fact plus the URL it was read from. */
export interface Evidence<T> {
  value: T;
  url: string;
}

export interface RepoBasics {
  name: string;
  fullName: string;
  description: string | null;
  visibility: string;
  pushedAt: string | null;
}

export interface CommitSummary {
  firstCommitAt: string | null;
  lastCommitAt: string | null;
  /** Commits in this repo authored by the token's own user. */
  authoredByUserCount: number;
}

export interface ManifestEvidence {
  path: string;
  content: string;
}

/**
 * What we read about one repo, grouped by the tier that produced it. A field
 * is present only when its tier was requested — never populated speculatively.
 */
export interface RepoEvidence {
  fullName: string;
  repo?: Evidence<RepoBasics>;
  languages?: Evidence<Record<string, number>>;
  topics?: Evidence<string[]>;
  commits?: Evidence<CommitSummary>;
  readme?: Evidence<string>;
  manifest?: Evidence<ManifestEvidence>;
}

export interface ReadRepoEvidenceOptions {
  tiers: EvidenceTier[];
  signal?: AbortSignal;
}

/** Reads evidence for one repo at the requested tiers. `fullName` is `owner/repo`. */
export async function readRepoEvidence(
  token: string,
  fullName: string,
  opts: ReadRepoEvidenceOptions,
): Promise<RepoEvidence> {
  for (const tier of opts.tiers) {
    if (tier === 3 || tier === 4) {
      // Tiers 3 (commit subjects and PR titles authored by you) and 4 (source
      // diffs) are specced but not built — see docs/CONTENT-SOURCES.md, Part 2,
      // "What we read". The LLM call that would consume them (`propose.ts`)
      // does not exist yet either.
      throw new Error(`Evidence tier ${tier} is not implemented yet; see docs/CONTENT-SOURCES.md.`);
    }
  }

  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    throw new GitHubError(`"${fullName}" is not an "owner/repo" full name.`, undefined, 'not-found');
  }

  const { signal } = opts;
  const evidence: RepoEvidence = { fullName };

  if (opts.tiers.includes(1)) {
    const repoUrl = `${API_ROOT}/repos/${owner}/${repo}`;
    const repoRes = await githubFetch(repoUrl, token, signal);
    const repoData = (await repoRes.json()) as Record<string, unknown>;
    evidence.repo = { value: toRepoBasics(repoData), url: repoUrl };
    evidence.topics = { value: (repoData.topics as string[] | undefined) ?? [], url: repoUrl };

    const languagesUrl = `${repoUrl}/languages`;
    const languagesRes = await githubFetch(languagesUrl, token, signal);
    evidence.languages = { value: (await languagesRes.json()) as Record<string, number>, url: languagesUrl };

    evidence.commits = await readCommitSummary(token, owner, repo, signal);
  }

  if (opts.tiers.includes(2)) {
    const readme = await tryReadContents(token, `${API_ROOT}/repos/${owner}/${repo}/readme`, signal);
    if (readme) {
      evidence.readme = { value: capBytes(readme.content, README_BYTE_CAP), url: readme.url };
    }

    for (const path of MANIFEST_CANDIDATES) {
      const file = await tryReadContents(token, `${API_ROOT}/repos/${owner}/${repo}/contents/${path}`, signal);
      if (file) {
        evidence.manifest = { value: { path, content: file.content }, url: file.url };
        break;
      }
    }
  }

  return evidence;
}

async function readCommitSummary(
  token: string,
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<Evidence<CommitSummary>> {
  const commitsUrl = `${API_ROOT}/repos/${owner}/${repo}/commits`;

  const latestRes = await githubFetch(`${commitsUrl}?per_page=1`, token, signal);
  const latest = (await latestRes.json()) as Array<{ commit?: { committer?: { date?: string } } }>;
  const lastCommitAt = latest[0]?.commit?.committer?.date ?? null;

  // With per_page=1, the "last" page is the oldest commit — one extra request
  // instead of paging through the whole history to find it.
  let firstCommitAt = lastCommitAt;
  const oldestPageUrl = parseLinkHeader(latestRes.headers.get('link')).last;
  if (oldestPageUrl) {
    const oldestRes = await githubFetch(oldestPageUrl, token, signal);
    const oldest = (await oldestRes.json()) as Array<{ commit?: { committer?: { date?: string } } }>;
    firstCommitAt = oldest[0]?.commit?.committer?.date ?? firstCommitAt;
  }

  const userRes = await githubFetch(`${API_ROOT}/user`, token, signal);
  const login = ((await userRes.json()) as { login?: string }).login ?? '';

  // Same trick, scoped to one author: the last page number is the count.
  const authorRes = await githubFetch(
    `${commitsUrl}?author=${encodeURIComponent(login)}&per_page=1`,
    token,
    signal,
  );
  const authorCommits = (await authorRes.json()) as unknown[];
  const authorLastPage = parseLinkHeader(authorRes.headers.get('link')).last;
  const authoredByUserCount = authorLastPage
    ? Number(new URL(authorLastPage).searchParams.get('page') ?? authorCommits.length)
    : authorCommits.length;

  return { value: { firstCommitAt, lastCommitAt, authoredByUserCount }, url: commitsUrl };
}

async function tryReadContents(
  token: string,
  url: string,
  signal?: AbortSignal,
): Promise<{ content: string; url: string } | null> {
  let res: Response;
  try {
    res = await githubFetch(url, token, signal);
  } catch (err) {
    if (err instanceof GitHubError && err.kind === 'not-found') return null;
    throw err;
  }
  const data = (await res.json()) as { content?: string; html_url?: string; url?: string };
  if (!data.content) return null;
  return { content: decodeBase64(data.content), url: data.html_url ?? data.url ?? url };
}

async function githubFetch(url: string, token: string, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (err) {
    throw new GitHubError('Could not reach the GitHub API.', err, 'network');
  }
  if (!res.ok) throw toGitHubError(res);
  return res;
}

function toGitHubError(res: Response): GitHubError {
  if (res.status === 401) {
    return new GitHubError('GitHub rejected the token.', undefined, 'auth');
  }
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      return new GitHubError('GitHub rate-limited the request. Wait and retry.', undefined, 'rate-limit');
    }
    return new GitHubError('GitHub refused the request as forbidden.', undefined, 'auth');
  }
  if (res.status === 404) {
    return new GitHubError('GitHub returned 404 for that resource.', undefined, 'not-found');
  }
  return new GitHubError(`GitHub returned ${res.status}.`, undefined, 'network');
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (match) links[match[2]!] = match[1]!;
  }
  return links;
}

function toRepoBasics(data: Record<string, unknown>): RepoBasics {
  return {
    name: str(data.name),
    fullName: str(data.full_name),
    description: (data.description as string | null) ?? null,
    visibility: str(data.visibility),
    pushedAt: (data.pushed_at as string | null) ?? null,
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function decodeBase64(b64: string): string {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

function capBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder('utf-8').decode(bytes.slice(0, maxBytes));
}
