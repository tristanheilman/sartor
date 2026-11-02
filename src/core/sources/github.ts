/**
 * Read-only client over `api.github.com`, used to gather evidence for the
 * "GitHub as a content source" feature (`docs/CONTENT-SOURCES.md`, Part 2).
 *
 * This module only reads. It takes a token as a plain argument and never
 * stores it — where the token comes from and what scope to ask for are the
 * owner's decisions (`src/storage/keys.ts`), untouched here.
 *
 * `api.github.com` sends `access-control-allow-origin: *`, so — like
 * `jd/ats.ts` for job postings — these requests go straight from the
 * browser, no proxy.
 *
 * `RepoEvidence` deliberately separates what was read from what a model is
 * later asked to do with it (`propose.ts`, a later issue). Every piece of
 * evidence carries the URL it came from, so a generated bullet can always be
 * traced back to its source.
 */

const API_BASE = 'https://api.github.com';

/** Bytes, not characters — a cap on file size, not glyph count. */
const README_BYTE_CAP = 20_000;
const MANIFEST_BYTE_CAP = 20_000;

const MANIFEST_CANDIDATES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'rate-limit' | 'not-found' | 'network',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RepoListing {
  name: string;
  fullName: string;
  description: string | null;
  visibility: 'public' | 'private';
  pushedAt: string;
  url: string;
}

export interface ListReposOptions {
  signal?: AbortSignal;
}

/** The opt-in data-minimisation ladder from `docs/CONTENT-SOURCES.md`. */
export type EvidenceTier = 1 | 2 | 3 | 4;

export interface ReadRepoEvidenceOptions {
  tiers: EvidenceTier[];
  signal?: AbortSignal;
}

export interface RepoEvidence {
  repo: RepoListing;
  languages: { names: string[]; url: string } | null;
  topics: { names: string[]; url: string } | null;
  commits: {
    firstCommitDate: string | null;
    lastCommitDate: string | null;
    authorCommitCount: number;
    url: string;
  } | null;
  readme: { text: string; truncated: boolean; url: string } | null;
  manifest: Array<{ filename: string; text: string; truncated: boolean; url: string }> | null;
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubFetch(
  url: string,
  token: string,
  signal?: AbortSignal,
  opts: { allowStatuses?: number[] } = {},
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(token), signal });
  } catch (err) {
    throw new GitHubError('Could not reach GitHub.', 'network', err);
  }

  if (res.ok || opts.allowStatuses?.includes(res.status)) {
    return res;
  }

  if (res.status === 401) {
    throw new GitHubError('GitHub rejected the token.', 'auth');
  }
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null) {
      throw new GitHubError('GitHub API rate limit exceeded.', 'rate-limit');
    }
    throw new GitHubError('GitHub rejected the request. The token may lack the needed scope.', 'auth');
  }
  if (res.status === 404) {
    throw new GitHubError('Not found on GitHub.', 'not-found');
  }
  if (res.status === 429) {
    throw new GitHubError('GitHub API rate limit exceeded.', 'rate-limit');
  }
  throw new GitHubError(`GitHub returned ${res.status}.`, 'network');
}

function linkRel(link: string | null, rel: string): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match && match[2] === rel) return match[1] ?? null;
  }
  return null;
}

function lastPageNumber(link: string | null): number | null {
  const last = linkRel(link, 'last');
  if (!last) return null;
  const match = last.match(/[?&]page=(\d+)/);
  return match ? Number(match[1]) : null;
}

/** `GET /user/repos`, paginated, limited to repos the token's owner owns. */
export async function listRepos(token: string, opts: ListReposOptions = {}): Promise<RepoListing[]> {
  const results: RepoListing[] = [];
  let url: string | null = `${API_BASE}/user/repos?affiliation=owner&per_page=100`;

  while (url) {
    const res = await githubFetch(url, token, opts.signal);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    for (const r of data) {
      results.push({
        name: String(r.name),
        fullName: String(r.full_name),
        description: (r.description as string | null) ?? null,
        visibility: r.private ? 'private' : 'public',
        pushedAt: String(r.pushed_at),
        url: String(r.html_url),
      });
    }
    url = linkRel(res.headers.get('link'), 'next');
  }

  return results;
}

/** Decodes a base64 payload as UTF-8, cut at `byteCap` bytes. */
function decodeBase64Capped(base64: string, byteCap: number): { text: string; truncated: boolean } {
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const truncated = bytes.length > byteCap;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(truncated ? bytes.subarray(0, byteCap) : bytes);
  return { text, truncated };
}

function commitDate(c: Record<string, unknown>): string | null {
  const commit = c.commit as Record<string, unknown> | undefined;
  const author = commit?.author as Record<string, unknown> | undefined;
  return (author?.date as string | undefined) ?? null;
}

async function getAuthenticatedLogin(token: string, signal?: AbortSignal): Promise<string> {
  const res = await githubFetch(`${API_BASE}/user`, token, signal);
  const data = (await res.json()) as Record<string, unknown>;
  return String(data.login);
}

/** GitHub answers the commits endpoint with 409 for a repo with no commits yet. */
const EMPTY_REPO_STATUS = 409;

async function getCommitDates(
  owner: string,
  repo: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ first: string | null; last: string | null; url: string }> {
  const url = `${API_BASE}/repos/${owner}/${repo}/commits?per_page=1`;
  const res = await githubFetch(url, token, signal, { allowStatuses: [EMPTY_REPO_STATUS] });
  if (res.status === EMPTY_REPO_STATUS) {
    return { first: null, last: null, url };
  }
  const data = (await res.json()) as Array<Record<string, unknown>>;
  const last = data[0] ? commitDate(data[0]) : null;

  const lastPage = lastPageNumber(res.headers.get('link'));
  let first = last;
  if (lastPage && lastPage > 1) {
    const firstRes = await githubFetch(`${url}&page=${lastPage}`, token, signal);
    const firstData = (await firstRes.json()) as Array<Record<string, unknown>>;
    first = firstData[0] ? commitDate(firstData[0]) : first;
  }

  return { first, last, url };
}

async function getAuthorCommitCount(
  owner: string,
  repo: string,
  login: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ count: number; url: string }> {
  const url = `${API_BASE}/repos/${owner}/${repo}/commits?author=${encodeURIComponent(login)}&per_page=1`;
  const res = await githubFetch(url, token, signal, { allowStatuses: [EMPTY_REPO_STATUS] });
  if (res.status === EMPTY_REPO_STATUS) {
    return { count: 0, url };
  }
  const data = (await res.json()) as unknown[];
  const lastPage = lastPageNumber(res.headers.get('link'));
  return { count: lastPage ?? data.length, url };
}

async function findManifests(
  owner: string,
  repo: string,
  token: string,
  signal?: AbortSignal,
): Promise<Array<{ filename: string; text: string; truncated: boolean; url: string }>> {
  const manifests: Array<{ filename: string; text: string; truncated: boolean; url: string }> = [];
  for (const filename of MANIFEST_CANDIDATES) {
    const url = `${API_BASE}/repos/${owner}/${repo}/contents/${filename}`;
    let res: Response;
    try {
      res = await githubFetch(url, token, signal);
    } catch (err) {
      if (err instanceof GitHubError && err.kind === 'not-found') continue;
      throw err;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const { text, truncated } = decodeBase64Capped(String(data.content ?? ''), MANIFEST_BYTE_CAP);
    manifests.push({ filename, text, truncated, url: String(data.html_url ?? url) });
  }
  return manifests;
}

function splitFullName(fullName: string): [owner: string, repo: string] {
  const idx = fullName.indexOf('/');
  if (idx === -1) throw new Error(`Expected "owner/repo", got "${fullName}".`);
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

/**
 * Reads evidence for one repo, up to the requested tiers.
 *
 * Tiers 3 (commit subjects and PR titles authored by the user) and 4 (source
 * diffs) are typed in the ladder but not implemented — see
 * `docs/CONTENT-SOURCES.md`, Part 2, "What we read". Requesting either throws.
 */
export async function readRepoEvidence(
  token: string,
  fullName: string,
  { tiers, signal }: ReadRepoEvidenceOptions,
): Promise<RepoEvidence> {
  if (tiers.includes(3) || tiers.includes(4)) {
    throw new Error('Tiers 3 and 4 are not implemented yet (docs/CONTENT-SOURCES.md, Part 2).');
  }

  const [owner, repo] = splitFullName(fullName);

  const repoUrl = `${API_BASE}/repos/${owner}/${repo}`;
  const repoRes = await githubFetch(repoUrl, token, signal);
  const repoData = (await repoRes.json()) as Record<string, unknown>;

  const evidence: RepoEvidence = {
    repo: {
      name: String(repoData.name),
      fullName: String(repoData.full_name),
      description: (repoData.description as string | null) ?? null,
      visibility: repoData.private ? 'private' : 'public',
      pushedAt: String(repoData.pushed_at),
      url: String(repoData.html_url),
    },
    languages: null,
    topics: null,
    commits: null,
    readme: null,
    manifest: null,
  };

  if (tiers.includes(1)) {
    const languagesUrl = `${API_BASE}/repos/${owner}/${repo}/languages`;
    const languagesRes = await githubFetch(languagesUrl, token, signal);
    const languagesData = (await languagesRes.json()) as Record<string, unknown>;
    evidence.languages = { names: Object.keys(languagesData), url: languagesUrl };

    evidence.topics = { names: (repoData.topics as string[] | undefined) ?? [], url: evidence.repo.url };

    const login = await getAuthenticatedLogin(token, signal);
    const dates = await getCommitDates(owner, repo, token, signal);
    const authored = await getAuthorCommitCount(owner, repo, login, token, signal);
    evidence.commits = {
      firstCommitDate: dates.first,
      lastCommitDate: dates.last,
      authorCommitCount: authored.count,
      url: dates.url,
    };
  }

  if (tiers.includes(2)) {
    const readmeUrl = `${API_BASE}/repos/${owner}/${repo}/readme`;
    try {
      const readmeRes = await githubFetch(readmeUrl, token, signal);
      const readmeData = (await readmeRes.json()) as Record<string, unknown>;
      const { text, truncated } = decodeBase64Capped(String(readmeData.content ?? ''), README_BYTE_CAP);
      evidence.readme = { text, truncated, url: String(readmeData.html_url ?? readmeUrl) };
    } catch (err) {
      if (!(err instanceof GitHubError && err.kind === 'not-found')) throw err;
    }

    const manifests = await findManifests(owner, repo, token, signal);
    evidence.manifest = manifests.length > 0 ? manifests : null;
  }

  return evidence;
}
