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
  stars: number;
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
  /**
   * The token owner's login, if already known. Tier 1's commit count needs
   * it; when it's omitted this fetches `GET /user` itself. Reading evidence
   * for many repos in one session should fetch it once up front with
   * `getAuthenticatedLogin` and pass it to every call, rather than paying for
   * a `/user` request per repo.
   */
  login?: string;
  signal?: AbortSignal;
}

/** The login of the token's own user — call once and reuse across repos. */
export async function getAuthenticatedLogin(token: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const userRes = await githubFetch(`${API_ROOT}/user`, token, opts.signal);
  const login = ((await userRes.json()) as { login?: string }).login;
  if (!login) {
    throw new Error('GitHub did not return a login for the authenticated user.');
  }
  return login;
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

  const [owner, repo, ...extra] = fullName.split('/');
  if (!owner || !repo || extra.length > 0) {
    throw new Error(`"${fullName}" is not an "owner/repo" full name.`);
  }

  const { signal } = opts;
  const evidence: RepoEvidence = { fullName };

  if (opts.tiers.includes(1)) {
    const repoUrl = repoApiUrl(owner, repo);
    const repoRes = await githubFetch(repoUrl, token, signal);
    const repoData = (await repoRes.json()) as Record<string, unknown>;
    evidence.repo = { value: toRepoBasics(repoData), url: repoUrl };
    evidence.topics = { value: (repoData.topics as string[] | undefined) ?? [], url: repoUrl };

    const languagesUrl = `${repoUrl}/languages`;
    const languagesRes = await githubFetch(languagesUrl, token, signal);
    evidence.languages = { value: (await languagesRes.json()) as Record<string, number>, url: languagesUrl };

    evidence.commits = await readCommitSummary(token, owner, repo, opts.login, signal);
  }

  if (opts.tiers.includes(2)) {
    const readme = await tryReadContents(token, `${repoApiUrl(owner, repo)}/readme`, signal);
    if (readme) {
      evidence.readme = { value: capBytes(readme.content, README_BYTE_CAP), url: readme.url };
    }

    for (const path of MANIFEST_CANDIDATES) {
      const file = await tryReadContents(
        token,
        `${repoApiUrl(owner, repo)}/contents/${encodeURIComponent(path)}`,
        signal,
      );
      if (file) {
        evidence.manifest = { value: { path, content: file.content }, url: file.url };
        break;
      }
    }
  }

  return evidence;
}

function repoApiUrl(owner: string, repo: string): string {
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function readCommitSummary(
  token: string,
  owner: string,
  repo: string,
  knownLogin: string | undefined,
  signal?: AbortSignal,
): Promise<Evidence<CommitSummary>> {
  const commitsUrl = `${repoApiUrl(owner, repo)}/commits`;

  // A repository with no commits yet (freshly created, no default branch)
  // reports 409 here rather than an empty array. That is "no commits", not a
  // failure to reach GitHub.
  let latestRes: Response;
  try {
    latestRes = await githubFetch(`${commitsUrl}?per_page=1`, token, signal);
  } catch (err) {
    if (err instanceof GitHubError && err.cause instanceof Response && err.cause.status === 409) {
      return { value: { firstCommitAt: null, lastCommitAt: null, authoredByUserCount: 0 }, url: commitsUrl };
    }
    throw err;
  }
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

  const login = knownLogin ?? (await getAuthenticatedLogin(token, { signal }));

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
  // Every request — including ones built from a `Link` header GitHub sent us
  // — stays inside the one host the token is ever given to.
  if (!url.startsWith(`${API_ROOT}/`)) {
    throw new GitHubError(`Refusing to send the token to a non-GitHub-API URL: ${url}`, undefined, 'network');
  }

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
    return new GitHubError('GitHub rejected the token.', res, 'auth');
  }
  if (res.status === 403) {
    // The primary rate limit shows up as `x-ratelimit-remaining: 0`; the
    // secondary (abuse-detection) limit instead sends `retry-after` and
    // leaves the ratelimit headers alone. Either means "wait and retry", not
    // "the token is bad".
    if (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null) {
      return new GitHubError('GitHub rate-limited the request. Wait and retry.', res, 'rate-limit');
    }
    return new GitHubError('GitHub refused the request as forbidden.', res, 'auth');
  }
  if (res.status === 404) {
    return new GitHubError('GitHub returned 404 for that resource.', res, 'not-found');
  }
  if (res.status === 429) {
    return new GitHubError('GitHub rate-limited the request. Wait and retry.', res, 'rate-limit');
  }
  // Includes 409, which GitHub uses for a repo with no commits yet; callers
  // that care about that case check `cause.status` themselves.
  return new GitHubError(`GitHub returned ${res.status}.`, res, 'network');
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
    stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
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

  // Back up off any trailing continuation byte (10xxxxxx) so the cut never
  // lands inside a multi-byte character — otherwise the decoder would turn
  // the fragment into a 3-byte U+FFFD and the result could exceed maxBytes.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder('utf-8').decode(bytes.slice(0, end));
}
