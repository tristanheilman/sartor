/**
 * Read layer for GitHub as a content source.
 *
 * A typed client over `api.github.com`, which — unlike `github.com` itself —
 * sends `access-control-allow-origin: *`, so the browser can call it directly
 * with a pasted token. Same shape of trick as `jd/ats.ts`.
 *
 * This module only *reads*. It takes a token as a plain argument and never
 * persists it; where that token comes from and what scope it needs are the
 * owner's decisions (`docs/CONTENT-SOURCES.md`, Part 2), not this module's.
 *
 * `RepoEvidence` deliberately separates what was read (this file) from what a
 * model is asked to do with it (`propose.ts`, a later piece of work) — see the
 * data-minimisation ladder in the doc. Tiers 1 and 2 are implemented; 3 and 4
 * are typed so callers can reason about the full ladder but are refused.
 */

const API_ROOT = 'https://api.github.com';

export type GitHubErrorKind = 'auth' | 'rate-limit' | 'not-found' | 'network';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubErrorKind,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export type RepoVisibility = 'public' | 'private' | 'internal';

export interface RepoSummary {
  name: string;
  fullName: string;
  description: string | null;
  visibility: RepoVisibility;
  pushedAt: string;
  url: string;
}

export interface ListReposOptions {
  signal?: AbortSignal;
}

/** Evidence of one fact, carrying the URL it was read from. */
export interface EvidenceItem<T> {
  value: T;
  url: string;
}

export interface CommitSummary {
  /** Oldest commit date by the authenticated user, or null if they have none. */
  firstCommitDate: string | null;
  /** Newest commit date by the authenticated user, or null if they have none. */
  lastCommitDate: string | null;
  authoredCommitCount: number;
}

export interface RepoBasics {
  name: string;
  fullName: string;
  description: string | null;
  visibility: RepoVisibility;
  pushedAt: string;
  stars: number;
  topics: string[];
}

/** Tier 1 and 2 of the data-minimisation ladder (`docs/CONTENT-SOURCES.md`). */
export interface RepoEvidence {
  repo: EvidenceItem<RepoBasics> | null;
  languages: EvidenceItem<Record<string, number>> | null;
  commits: EvidenceItem<CommitSummary> | null;
  readme: EvidenceItem<string> | null;
  manifest: EvidenceItem<{ path: string; content: string }> | null;
}

export type EvidenceTier = 1 | 2 | 3 | 4;

export interface ReadRepoEvidenceOptions {
  tiers: EvidenceTier[];
}

async function githubFetch(token: string, url: string, signal?: AbortSignal): Promise<Response> {
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
    throw new GitHubError('Could not reach the GitHub API.', 'network', err);
  }

  if (res.status === 401) {
    throw new GitHubError('GitHub rejected the token.', 'auth');
  }
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubError('GitHub rate limit exceeded.', 'rate-limit');
    }
    throw new GitHubError('GitHub refused the request for this token.', 'auth');
  }
  if (res.status === 404) {
    throw new GitHubError('Not found on GitHub.', 'not-found');
  }
  if (!res.ok) {
    throw new GitHubError(`GitHub returned ${res.status}.`, 'network');
  }
  return res;
}

function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]!] = match[1]!;
  }
  return links;
}

function repoVisibility(data: Record<string, unknown>): RepoVisibility {
  if (data.visibility === 'public' || data.visibility === 'private' || data.visibility === 'internal') {
    return data.visibility;
  }
  return data.private ? 'private' : 'public';
}

/** Lists repositories the token's owner personally owns, across all pages. */
export async function listRepos(token: string, opts: ListReposOptions = {}): Promise<RepoSummary[]> {
  const repos: RepoSummary[] = [];
  let url: string | null = `${API_ROOT}/user/repos?affiliation=owner&per_page=100`;

  while (url) {
    const res = await githubFetch(token, url, opts.signal);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    for (const r of data) {
      repos.push({
        name: String(r.name),
        fullName: String(r.full_name),
        description: (r.description as string | null | undefined) ?? null,
        visibility: repoVisibility(r),
        pushedAt: String(r.pushed_at),
        url: String(r.html_url),
      });
    }
    url = parseLinkHeader(res.headers.get('link')).next ?? null;
  }

  return repos;
}

function decodeBase64Content(base64: string): string {
  const binary = atob(base64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function capBytes(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder('utf-8').decode(bytes.slice(0, maxBytes));
}

const README_BYTE_CAP = 20_000;
const MANIFEST_CANDIDATES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];

function commitDate(commit: Record<string, unknown> | undefined): string | null {
  const commitObj = commit?.commit as Record<string, unknown> | undefined;
  const author = commitObj?.author as Record<string, unknown> | undefined;
  return (author?.date as string | undefined) ?? null;
}

async function readCommitSummary(token: string, fullName: string): Promise<EvidenceItem<CommitSummary>> {
  const userRes = await githubFetch(token, `${API_ROOT}/user`);
  const user = (await userRes.json()) as Record<string, unknown>;
  const login = String(user.login);

  const url = `${API_ROOT}/repos/${fullName}/commits?author=${encodeURIComponent(login)}&per_page=1`;
  const newestRes = await githubFetch(token, url);
  const newestPage = (await newestRes.json()) as Array<Record<string, unknown>>;

  if (newestPage.length === 0) {
    return { url, value: { firstCommitDate: null, lastCommitDate: null, authoredCommitCount: 0 } };
  }

  const lastCommitDate = commitDate(newestPage[0]);
  const links = parseLinkHeader(newestRes.headers.get('link'));

  if (!links.last) {
    return { url, value: { firstCommitDate: lastCommitDate, lastCommitDate, authoredCommitCount: 1 } };
  }

  const lastPageNumber = Number(new URL(links.last).searchParams.get('page') ?? '1');
  const oldestRes = await githubFetch(token, links.last);
  const oldestPage = (await oldestRes.json()) as Array<Record<string, unknown>>;

  return {
    url,
    value: {
      firstCommitDate: commitDate(oldestPage[0]),
      lastCommitDate,
      authoredCommitCount: lastPageNumber,
    },
  };
}

async function readReadme(token: string, fullName: string): Promise<EvidenceItem<string> | null> {
  const url = `${API_ROOT}/repos/${fullName}/readme`;
  let res: Response;
  try {
    res = await githubFetch(token, url);
  } catch (err) {
    if (err instanceof GitHubError && err.kind === 'not-found') return null;
    throw err;
  }
  const data = (await res.json()) as Record<string, unknown>;
  const content = capBytes(decodeBase64Content(String(data.content ?? '')), README_BYTE_CAP);
  return { url: String(data.html_url ?? url), value: content };
}

async function readManifest(
  token: string,
  fullName: string,
): Promise<EvidenceItem<{ path: string; content: string }> | null> {
  for (const path of MANIFEST_CANDIDATES) {
    const url = `${API_ROOT}/repos/${fullName}/contents/${path}`;
    let res: Response;
    try {
      res = await githubFetch(token, url);
    } catch (err) {
      if (err instanceof GitHubError && err.kind === 'not-found') continue;
      throw err;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const content = decodeBase64Content(String(data.content ?? ''));
    return { url: String(data.html_url ?? url), value: { path, content } };
  }
  return null;
}

/**
 * Reads evidence for one repository, up to the requested tiers.
 *
 * Only tiers 1 and 2 are built. Tiers 3 (commit subjects and PR titles
 * authored by you) and 4 (source diffs) are the next step on the ladder in
 * `docs/CONTENT-SOURCES.md` ("What we read") and are refused here rather than
 * silently returning nothing.
 */
export async function readRepoEvidence(
  token: string,
  fullName: string,
  opts: ReadRepoEvidenceOptions,
): Promise<RepoEvidence> {
  const tiers = new Set(opts.tiers);
  if (tiers.has(3) || tiers.has(4)) {
    // Commit/PR titles (3) and source diffs (4) — see "What we read" in
    // docs/CONTENT-SOURCES.md. Not built yet; refuse rather than return
    // evidence that is silently missing what was asked for.
    throw new Error('Tiers 3 and 4 are not implemented yet.');
  }

  const evidence: RepoEvidence = { repo: null, languages: null, commits: null, readme: null, manifest: null };

  if (tiers.has(1)) {
    const repoUrl = `${API_ROOT}/repos/${fullName}`;
    const repoRes = await githubFetch(token, repoUrl);
    const repoData = (await repoRes.json()) as Record<string, unknown>;
    evidence.repo = {
      url: repoUrl,
      value: {
        name: String(repoData.name),
        fullName: String(repoData.full_name),
        description: (repoData.description as string | null | undefined) ?? null,
        visibility: repoVisibility(repoData),
        pushedAt: String(repoData.pushed_at),
        stars: Number(repoData.stargazers_count ?? 0),
        topics: Array.isArray(repoData.topics) ? repoData.topics.map(String) : [],
      },
    };

    const languagesUrl = `${API_ROOT}/repos/${fullName}/languages`;
    const languagesRes = await githubFetch(token, languagesUrl);
    evidence.languages = { url: languagesUrl, value: (await languagesRes.json()) as Record<string, number> };

    evidence.commits = await readCommitSummary(token, fullName);
  }

  if (tiers.has(2)) {
    evidence.readme = await readReadme(token, fullName);
    evidence.manifest = await readManifest(token, fullName);
  }

  return evidence;
}
