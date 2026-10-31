/**
 * Read-only client for GitHub repository evidence.
 *
 * Every request goes straight from the caller to `api.github.com`, which sends
 * `access-control-allow-origin: *` — the same reasoning as `jd/ats.ts`, which
 * is the precedent for fetching third-party JSON directly from the browser.
 * See `docs/CONTENT-SOURCES.md`, Part 2, "What we read", for the design this
 * follows, including the opt-in evidence ladder.
 *
 * This module only reads. It takes a token as a plain argument and never
 * stores it — where and how a token is kept is the owner's call
 * (`storage/keys.ts`, reserved in `ROADMAP.md`), untouched here.
 */

const API_BASE = 'https://api.github.com';

export type GitHubErrorKind = 'auth' | 'rate-limit' | 'not-found' | 'network';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly kind: GitHubErrorKind = 'network',
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RepoSummary {
  name: string;
  fullName: string;
  description: string | null;
  visibility: 'public' | 'private' | 'internal';
  pushedAt: string | null;
  url: string;
}

/** A piece of evidence paired with the URL it was read from. */
export interface Evidenced<T> {
  value: T;
  url: string;
}

/** Tiers 3 and 4 are typed here but not read yet — see the module doc comment. */
export type EvidenceTier = 1 | 2 | 3 | 4;

export interface CommitEvidence {
  firstCommitAt: string | null;
  lastCommitAt: string | null;
  /** Commits on the default branch authored by the token's own user. */
  authoredCommitCount: number;
}

export interface ManifestEvidence {
  /** Which of the candidate manifest files was found. */
  path: string;
  content: string;
}

export interface RepoEvidence {
  repo: Evidenced<{
    name: string;
    fullName: string;
    description: string | null;
    visibility: 'public' | 'private' | 'internal';
    pushedAt: string | null;
  }>;
  /** Tier 1. Populated only when `tiers` includes 1. */
  languages: Evidenced<Record<string, number>> | null;
  topics: Evidenced<string[]> | null;
  commits: Evidenced<CommitEvidence> | null;
  /** Tier 2. Populated only when `tiers` includes 2. */
  readme: Evidenced<string> | null;
  manifest: Evidenced<ManifestEvidence> | null;
}

export interface ListReposOptions {
  signal?: AbortSignal;
}

export interface ReadRepoEvidenceOptions {
  tiers: EvidenceTier[];
  signal?: AbortSignal;
}

/** A long README would dominate the prompt budget; this keeps it bounded. */
const README_BYTE_CAP = 20_000;

/** Checked in this order; the first one present wins. */
const MANIFEST_CANDIDATES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];

interface GitHubRepoRaw {
  name: string;
  full_name: string;
  description: string | null;
  visibility: 'public' | 'private' | 'internal';
  pushed_at: string | null;
  html_url: string;
  topics?: string[];
}

interface GitHubCommitRaw {
  commit: {
    author: { date: string } | null;
    committer: { date: string } | null;
  };
}

interface GitHubContentRaw {
  content: string;
  encoding: string;
  html_url: string;
}

function githubHeaders(token: string, extra?: HeadersInit): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function rawFetch(urlOrPath: string, token: string, init?: RequestInit): Promise<Response> {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `${API_BASE}${urlOrPath}`;
  try {
    return await fetch(url, { ...init, headers: githubHeaders(token, init?.headers) });
  } catch (err) {
    throw new GitHubError('Could not reach GitHub.', err, 'network');
  }
}

function toGitHubError(res: Response): GitHubError {
  if (res.status === 401) {
    return new GitHubError('GitHub rejected the token.', undefined, 'auth');
  }
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      return new GitHubError('GitHub rate limit reached. Wait and retry.', undefined, 'rate-limit');
    }
    return new GitHubError('GitHub refused the request for this token.', undefined, 'auth');
  }
  if (res.status === 404) {
    return new GitHubError('Not found on GitHub.', undefined, 'not-found');
  }
  return new GitHubError(`GitHub returned ${res.status}.`, undefined, 'network');
}

async function getJson<T>(
  urlOrPath: string,
  token: string,
  signal: AbortSignal | undefined,
): Promise<{ data: T; res: Response }> {
  const res = await rawFetch(urlOrPath, token, { signal });
  if (!res.ok) throw toGitHubError(res);
  return { data: (await res.json()) as T, res };
}

/** `rel="next"` / `rel="last"` etc. from a GitHub pagination `Link` header. */
function parseLinkHeader(header: string | null): Record<string, string> {
  const links: Record<string, string> = {};
  if (!header) return links;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part);
    if (match) links[match[2]!] = match[1]!;
  }
  return links;
}

function decodeRepoFileContent(base64: string, byteCap = Infinity): string {
  const binary = atob(base64.replace(/\n/g, ''));
  const length = Math.min(binary.length, byteCap);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** `GET /user/repos`, paginated, limited to repos the token's user owns. */
export async function listRepos(token: string, opts: ListReposOptions = {}): Promise<RepoSummary[]> {
  const repos: RepoSummary[] = [];
  let cursor: string | null = '/user/repos?affiliation=owner&per_page=100';

  while (cursor) {
    const page: { data: GitHubRepoRaw[]; res: Response } = await getJson<GitHubRepoRaw[]>(
      cursor,
      token,
      opts.signal,
    );
    for (const repo of page.data) {
      repos.push({
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        visibility: repo.visibility,
        pushedAt: repo.pushed_at,
        url: repo.html_url,
      });
    }
    cursor = parseLinkHeader(page.res.headers.get('link')).next ?? null;
  }

  return repos;
}

async function readCommitEvidence(
  token: string,
  owner: string,
  repo: string,
  signal: AbortSignal | undefined,
): Promise<Evidenced<CommitEvidence>> {
  const base = `/repos/${owner}/${repo}/commits`;

  const user = await getJson<{ login: string }>('/user', token, signal);

  const latest = await getJson<GitHubCommitRaw[]>(`${base}?per_page=1`, token, signal);
  const latestCommit = latest.data[0];
  const lastCommitAt = latestCommit ? latestCommit.commit.committer?.date ?? latestCommit.commit.author?.date ?? null : null;

  let firstCommitAt = lastCommitAt;
  const lastPageUrl = parseLinkHeader(latest.res.headers.get('link')).last;
  if (lastPageUrl) {
    const oldest = await getJson<GitHubCommitRaw[]>(lastPageUrl, token, signal);
    const oldestCommit = oldest.data[0];
    firstCommitAt = oldestCommit ? oldestCommit.commit.committer?.date ?? oldestCommit.commit.author?.date ?? null : null;
  }

  const authored = await getJson<GitHubCommitRaw[]>(
    `${base}?author=${encodeURIComponent(user.data.login)}&per_page=1`,
    token,
    signal,
  );
  const authoredLastPage = parseLinkHeader(authored.res.headers.get('link')).last;
  const authoredCommitCount = authoredLastPage
    ? Number(new URL(authoredLastPage).searchParams.get('page') ?? authored.data.length)
    : authored.data.length;

  return {
    value: { firstCommitAt, lastCommitAt, authoredCommitCount },
    url: `${API_BASE}${base}`,
  };
}

async function readReadme(
  token: string,
  owner: string,
  repo: string,
  signal: AbortSignal | undefined,
): Promise<Evidenced<string> | null> {
  try {
    const content = await getJson<GitHubContentRaw>(`/repos/${owner}/${repo}/readme`, token, signal);
    return { value: decodeRepoFileContent(content.data.content, README_BYTE_CAP), url: content.data.html_url };
  } catch (err) {
    if (err instanceof GitHubError && err.kind === 'not-found') return null;
    throw err;
  }
}

async function readManifest(
  token: string,
  owner: string,
  repo: string,
  signal: AbortSignal | undefined,
): Promise<Evidenced<ManifestEvidence> | null> {
  for (const path of MANIFEST_CANDIDATES) {
    try {
      const content = await getJson<GitHubContentRaw>(`/repos/${owner}/${repo}/contents/${path}`, token, signal);
      return { value: { path, content: decodeRepoFileContent(content.data.content) }, url: content.data.html_url };
    } catch (err) {
      if (err instanceof GitHubError && err.kind === 'not-found') continue;
      throw err;
    }
  }
  return null;
}

/**
 * Reads evidence for one repository, up to the requested tiers.
 *
 * Tiers 3 (commit subjects and PR titles authored by the user) and 4 (source
 * diffs) are part of the ladder in `docs/CONTENT-SOURCES.md` but not read by
 * this function yet; requesting either throws.
 */
export async function readRepoEvidence(
  token: string,
  fullName: string,
  opts: ReadRepoEvidenceOptions,
): Promise<RepoEvidence> {
  if (opts.tiers.includes(3) || opts.tiers.includes(4)) {
    throw new Error(
      'GitHub evidence tiers 3 and 4 are not implemented yet (see docs/CONTENT-SOURCES.md, Part 2, "What we read").',
    );
  }

  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    throw new Error(`Expected a "owner/repo" full name, got "${fullName}".`);
  }

  const repoResult = await getJson<GitHubRepoRaw>(`/repos/${owner}/${repo}`, token, opts.signal);
  const repoData = repoResult.data;

  const evidence: RepoEvidence = {
    repo: {
      value: {
        name: repoData.name,
        fullName: repoData.full_name,
        description: repoData.description,
        visibility: repoData.visibility,
        pushedAt: repoData.pushed_at,
      },
      url: repoData.html_url,
    },
    languages: null,
    topics: null,
    commits: null,
    readme: null,
    manifest: null,
  };

  if (opts.tiers.includes(1)) {
    evidence.topics = { value: repoData.topics ?? [], url: repoData.html_url };

    const languages = await getJson<Record<string, number>>(`/repos/${owner}/${repo}/languages`, token, opts.signal);
    evidence.languages = { value: languages.data, url: `${API_BASE}/repos/${owner}/${repo}/languages` };

    evidence.commits = await readCommitEvidence(token, owner, repo, opts.signal);
  }

  if (opts.tiers.includes(2)) {
    evidence.readme = await readReadme(token, owner, repo, opts.signal);
    evidence.manifest = await readManifest(token, owner, repo, opts.signal);
  }

  return evidence;
}
