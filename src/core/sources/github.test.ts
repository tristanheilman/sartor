import { describe, it, expect, afterEach, vi } from 'vitest';
import { GitHubError, listRepos, readRepoEvidence } from './github';

/**
 * Intercepts `fetch` the way `provider/provider.test.ts` does: no real
 * network call, no token needed. Responses are served from a queue in call
 * order, since `readRepoEvidence` makes several sequential requests.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
}

const captured: Captured[] = [];

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function queueFetch(responses: Response[]) {
  let i = 0;
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input as Request)?.headers).forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    captured.push({ url, headers });
    const res = responses[i];
    i += 1;
    if (!res) throw new Error(`Unexpected extra fetch call to ${url}`);
    return Promise.resolve(res);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  captured.length = 0;
});

const repoRaw = {
  name: 'sartor',
  full_name: 'octocat/sartor',
  description: 'A resume tailoring tool.',
  visibility: 'public' as const,
  pushed_at: '2026-01-05T00:00:00Z',
  html_url: 'https://github.com/octocat/sartor',
  topics: ['resume', 'typescript'],
};

describe('listRepos', () => {
  it('requests the owned-repos endpoint with the required headers', async () => {
    queueFetch([jsonResponse([])]);
    await listRepos('gh-token');

    expect(captured[0]!.url).toBe('https://api.github.com/user/repos?affiliation=owner&per_page=100');
    expect(captured[0]!.headers['authorization']).toBe('Bearer gh-token');
    expect(captured[0]!.headers['accept']).toBe('application/vnd.github+json');
    expect(captured[0]!.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('maps the fields the issue asks for', async () => {
    queueFetch([jsonResponse([repoRaw])]);
    const repos = await listRepos('gh-token');

    expect(repos).toEqual([
      {
        name: 'sartor',
        fullName: 'octocat/sartor',
        description: 'A resume tailoring tool.',
        visibility: 'public',
        pushedAt: '2026-01-05T00:00:00Z',
        url: 'https://github.com/octocat/sartor',
      },
    ]);
  });

  it('follows the Link header across pages', async () => {
    const nextUrl = 'https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2';
    queueFetch([
      jsonResponse([{ ...repoRaw, name: 'a' }], { headers: { link: `<${nextUrl}>; rel="next"` } }),
      jsonResponse([{ ...repoRaw, name: 'b' }]),
    ]);

    const repos = await listRepos('gh-token');

    expect(repos.map((r) => r.name)).toEqual(['a', 'b']);
    expect(captured[1]!.url).toBe(nextUrl);
  });
});

describe('readRepoEvidence — tier 1', () => {
  it('reads languages, topics and commit stats, and populates no tier-2 field', async () => {
    queueFetch([
      jsonResponse(repoRaw),
      jsonResponse({ TypeScript: 12345, HTML: 10 }),
      jsonResponse({ login: 'octocat' }),
      jsonResponse([{ commit: { author: { date: '2026-01-05T00:00:00Z' }, committer: { date: '2026-01-05T00:00:00Z' } } }], {
        headers: {
          link: '<https://api.github.com/repos/octocat/sartor/commits?per_page=1&page=40>; rel="last"',
        },
      }),
      jsonResponse([{ commit: { author: { date: '2024-02-01T00:00:00Z' }, committer: { date: '2024-02-01T00:00:00Z' } } }]),
      jsonResponse([{ commit: { author: { date: '2026-01-05T00:00:00Z' }, committer: { date: '2026-01-05T00:00:00Z' } } }], {
        headers: {
          link: '<https://api.github.com/repos/octocat/sartor/commits?author=octocat&per_page=1&page=7>; rel="last"',
        },
      }),
    ]);

    const evidence = await readRepoEvidence('gh-token', 'octocat/sartor', { tiers: [1] });

    expect(evidence.repo).toEqual({
      value: {
        name: 'sartor',
        fullName: 'octocat/sartor',
        description: 'A resume tailoring tool.',
        visibility: 'public',
        pushedAt: '2026-01-05T00:00:00Z',
      },
      url: 'https://github.com/octocat/sartor',
    });
    expect(evidence.topics).toEqual({ value: ['resume', 'typescript'], url: 'https://github.com/octocat/sartor' });
    expect(evidence.languages).toEqual({
      value: { TypeScript: 12345, HTML: 10 },
      url: 'https://api.github.com/repos/octocat/sartor/languages',
    });
    expect(evidence.commits).toEqual({
      value: {
        firstCommitAt: '2024-02-01T00:00:00Z',
        lastCommitAt: '2026-01-05T00:00:00Z',
        authoredCommitCount: 7,
      },
      url: 'https://api.github.com/repos/octocat/sartor/commits',
    });

    // Tier 2 fields stay untouched when only tier 1 was requested.
    expect(evidence.readme).toBeNull();
    expect(evidence.manifest).toBeNull();
  });

  it('pins the headers on every request, including the derived pagination URL', async () => {
    queueFetch([
      jsonResponse(repoRaw),
      jsonResponse({}),
      jsonResponse({ login: 'octocat' }),
      jsonResponse([{ commit: { author: { date: 'd' }, committer: { date: 'd' } } }]),
      jsonResponse([{ commit: { author: { date: 'd' }, committer: { date: 'd' } } }]),
    ]);

    await readRepoEvidence('gh-token', 'octocat/sartor', { tiers: [1] });

    for (const call of captured) {
      expect(call.headers['authorization']).toBe('Bearer gh-token');
      expect(call.headers['accept']).toBe('application/vnd.github+json');
      expect(call.headers['x-github-api-version']).toBe('2022-11-28');
    }
  });
});

describe('readRepoEvidence — tier 2', () => {
  function toBase64(text: string): string {
    return btoa(text);
  }

  it('decodes the README and populates no tier-1 field', async () => {
    queueFetch([
      jsonResponse(repoRaw),
      jsonResponse({ content: toBase64('# Sartor\n\nA resume tool.'), encoding: 'base64', html_url: 'https://github.com/octocat/sartor/blob/main/README.md' }),
      jsonResponse({}, { status: 404 }),
      jsonResponse({}, { status: 404 }),
      jsonResponse({}, { status: 404 }),
      jsonResponse({}, { status: 404 }),
    ]);

    const evidence = await readRepoEvidence('gh-token', 'octocat/sartor', { tiers: [2] });

    expect(evidence.readme).toEqual({
      value: '# Sartor\n\nA resume tool.',
      url: 'https://github.com/octocat/sartor/blob/main/README.md',
    });
    expect(evidence.manifest).toBeNull();

    // Tier 1 fields stay untouched when only tier 2 was requested.
    expect(evidence.languages).toBeNull();
    expect(evidence.topics).toBeNull();
    expect(evidence.commits).toBeNull();
  });

  it('cuts the README at the byte cap', async () => {
    const huge = 'a'.repeat(25_000);
    queueFetch([
      jsonResponse(repoRaw),
      jsonResponse({ content: toBase64(huge), encoding: 'base64', html_url: 'https://github.com/octocat/sartor/blob/main/README.md' }),
      jsonResponse({}, { status: 404 }),
      jsonResponse({}, { status: 404 }),
      jsonResponse({}, { status: 404 }),
      jsonResponse({}, { status: 404 }),
    ]);

    const evidence = await readRepoEvidence('gh-token', 'octocat/sartor', { tiers: [2] });

    expect(evidence.readme!.value.length).toBe(20_000);
  });

  it('finds the first manifest present among the candidates', async () => {
    queueFetch([
      jsonResponse(repoRaw),
      jsonResponse({}, { status: 404 }), // no readme
      jsonResponse({}, { status: 404 }), // package.json
      jsonResponse({
        content: toBase64('[project]\nname = "sartor"\n'),
        encoding: 'base64',
        html_url: 'https://github.com/octocat/sartor/blob/main/pyproject.toml',
      }),
    ]);

    const evidence = await readRepoEvidence('gh-token', 'octocat/sartor', { tiers: [2] });

    expect(evidence.manifest).toEqual({
      value: { path: 'pyproject.toml', content: '[project]\nname = "sartor"\n' },
      url: 'https://github.com/octocat/sartor/blob/main/pyproject.toml',
    });
  });
});

describe('readRepoEvidence — tiers 3 and 4', () => {
  it('throws rather than silently returning nothing', async () => {
    await expect(readRepoEvidence('gh-token', 'octocat/sartor', { tiers: [3] })).rejects.toThrow(/tier/i);
    await expect(readRepoEvidence('gh-token', 'octocat/sartor', { tiers: [4] })).rejects.toThrow(/tier/i);
  });
});

describe('error mapping', () => {
  it('maps 401 to auth', async () => {
    queueFetch([jsonResponse({ message: 'Bad credentials' }, { status: 401 })]);
    await expect(listRepos('bad-token')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a rate-limited 403 to rate-limit', async () => {
    queueFetch([
      jsonResponse({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    ]);
    await expect(listRepos('gh-token')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps a plain 403 to auth', async () => {
    queueFetch([jsonResponse({ message: 'Forbidden' }, { status: 403 })]);
    await expect(listRepos('gh-token')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps 404 to not-found', async () => {
    queueFetch([jsonResponse({ message: 'Not Found' }, { status: 404 })]);
    await expect(readRepoEvidence('gh-token', 'octocat/missing', { tiers: [] })).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('maps a fetch-level failure to network', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await expect(listRepos('gh-token')).rejects.toMatchObject({ kind: 'network' });
  });

  it('is an instance of GitHubError', async () => {
    queueFetch([jsonResponse({}, { status: 401 })]);
    await expect(listRepos('gh-token')).rejects.toBeInstanceOf(GitHubError);
  });
});

describe('request scope', () => {
  it('never calls anything other than api.github.com', async () => {
    queueFetch([
      jsonResponse(repoRaw),
      jsonResponse({}),
      jsonResponse({ login: 'octocat' }),
      jsonResponse([{ commit: { author: { date: 'd' }, committer: { date: 'd' } } }]),
      jsonResponse([{ commit: { author: { date: 'd' }, committer: { date: 'd' } } }]),
    ]);
    await readRepoEvidence('gh-token', 'octocat/sartor', { tiers: [1] });

    for (const call of captured) {
      expect(call.url.startsWith('https://api.github.com')).toBe(true);
    }
  });
});
