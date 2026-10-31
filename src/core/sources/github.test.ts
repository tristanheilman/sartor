import { describe, it, expect, afterEach, vi } from 'vitest';
import { getAuthenticatedLogin, listRepos, readRepoEvidence } from './github';

/**
 * Intercepts `fetch` the way `provider/provider.test.ts` does, rather than
 * calling the real API: pins the request shape and headers, and checks the
 * pagination, decoding and error-mapping rules that would otherwise only
 * surface as a confusing failure in a user's browser.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
}

const captured: Captured[] = [];

function capture(input: unknown, init: RequestInit | undefined) {
  const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (input as Request)?.headers).forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  captured.push({ url, headers });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Returns responses from a fixed queue, one per call, in order. */
function queueFetch(responses: Response[]) {
  let i = 0;
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    capture(input, init);
    const res = responses[i++];
    if (!res) throw new Error(`Unexpected fetch call #${i}`);
    return Promise.resolve(res);
  });
}

/** Routes by URL, for calls whose order is an implementation detail. */
function routeFetch(router: (url: string) => Response) {
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    capture(input, init);
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    return Promise.resolve(router(url));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  captured.length = 0;
});

/* ------------------------------------------------------------------ */

describe('listRepos', () => {
  it('sends the pinned auth headers', async () => {
    queueFetch([jsonResponse([])]);
    await listRepos('tok-123');
    expect(captured[0]!.headers.authorization).toBe('Bearer tok-123');
    expect(captured[0]!.headers.accept).toBe('application/vnd.github+json');
    expect(captured[0]!.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('requests only repos the token owner owns', async () => {
    queueFetch([jsonResponse([])]);
    await listRepos('tok');
    expect(captured[0]!.url).toBe('https://api.github.com/user/repos?affiliation=owner&per_page=100');
  });

  it('maps fields from the repo list response', async () => {
    queueFetch([
      jsonResponse([
        {
          name: 'demo',
          full_name: 'me/demo',
          description: 'A demo repo',
          visibility: 'public',
          pushed_at: '2024-06-01T00:00:00Z',
          html_url: 'https://github.com/me/demo',
        },
      ]),
    ]);
    const repos = await listRepos('tok');
    expect(repos).toEqual([
      {
        name: 'demo',
        fullName: 'me/demo',
        description: 'A demo repo',
        visibility: 'public',
        pushedAt: '2024-06-01T00:00:00Z',
        url: 'https://github.com/me/demo',
      },
    ]);
  });

  it('follows the Link header across pages', async () => {
    queueFetch([
      jsonResponse([{ name: 'a', full_name: 'me/a', html_url: 'https://github.com/me/a' }], 200, {
        link: '<https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2>; rel="next"',
      }),
      jsonResponse([{ name: 'b', full_name: 'me/b', html_url: 'https://github.com/me/b' }]),
    ]);
    const repos = await listRepos('tok');
    expect(repos.map((r) => r.name)).toEqual(['a', 'b']);
    expect(captured[1]!.url).toBe('https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2');
  });
});

describe('error mapping', () => {
  it('maps 401 to auth', async () => {
    queueFetch([jsonResponse({ message: 'Bad credentials' }, 401)]);
    await expect(listRepos('bad')).rejects.toMatchObject({ name: 'GitHubError', kind: 'auth' });
  });

  it('maps 403 with no rate-limit remaining to rate-limit', async () => {
    queueFetch([jsonResponse({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0' })]);
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps a plain 403 to auth, not rate-limit', async () => {
    queueFetch([jsonResponse({ message: 'forbidden' }, 403)]);
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a 403 with retry-after (the secondary rate limit) to rate-limit', async () => {
    queueFetch([jsonResponse({ message: 'secondary rate limit' }, 403, { 'retry-after': '30' })]);
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps 429 to rate-limit', async () => {
    queueFetch([jsonResponse({ message: 'too many requests' }, 429)]);
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps 404 to not-found', async () => {
    queueFetch([jsonResponse({ message: 'Not Found' }, 404)]);
    await expect(readRepoEvidence('tok', 'me/missing', { tiers: [1] })).rejects.toMatchObject({
      kind: 'not-found',
    });
  });

  it('maps a fetch-level failure to network', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('boom')));
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'network' });
  });

  it('refuses to follow a Link header that points off api.github.com', async () => {
    queueFetch([
      jsonResponse([{ name: 'a', full_name: 'me/a', html_url: 'https://github.com/me/a' }], 200, {
        link: '<https://evil.example.com/user/repos?page=2>; rel="next"',
      }),
    ]);
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'network' });
    expect(captured).toHaveLength(1);
  });
});

describe('getAuthenticatedLogin', () => {
  it('returns the login, for a caller reusing it across several readRepoEvidence calls', async () => {
    queueFetch([jsonResponse({ login: 'me' })]);
    await expect(getAuthenticatedLogin('tok')).resolves.toBe('me');
    expect(captured[0]!.url).toBe('https://api.github.com/user');
  });

  it('throws when GitHub returns no login', async () => {
    queueFetch([jsonResponse({})]);
    await expect(getAuthenticatedLogin('tok')).rejects.toThrow(/login/i);
  });
});

describe('readRepoEvidence input validation', () => {
  it('rejects a name with no slash, without making a request', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('fetch should not be called');
    });
    await expect(readRepoEvidence('tok', 'not-a-full-name', { tiers: [1] })).rejects.toThrow(
      /owner\/repo/,
    );
  });

  it('rejects a name with extra segments, without making a request', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('fetch should not be called');
    });
    await expect(readRepoEvidence('tok', 'me/demo/extra', { tiers: [1] })).rejects.toThrow(/owner\/repo/);
  });
});

/* ------------------------------------------------------------------ */

function makeEvidenceRouter(
  opts: {
    readmeContent?: string;
    manifestPath?: string | null;
    login?: string | null;
    commitsStatus?: number;
  } = {},
) {
  const { readmeContent = '# Demo\n\nSome text.', manifestPath = 'package.json', login = 'me', commitsStatus } =
    opts;

  return (url: string): Response => {
    if (url === 'https://api.github.com/repos/me/demo') {
      return jsonResponse({
        name: 'demo',
        full_name: 'me/demo',
        description: 'A demo repo',
        visibility: 'public',
        pushed_at: '2024-06-01T00:00:00Z',
        html_url: 'https://github.com/me/demo',
        topics: ['cli', 'tools'],
        stargazers_count: 42,
      });
    }
    if (url === 'https://api.github.com/repos/me/demo/languages') {
      return jsonResponse({ TypeScript: 1000, JavaScript: 200 });
    }
    if (url === 'https://api.github.com/repos/me/demo/commits?per_page=1') {
      if (commitsStatus) return jsonResponse({ message: 'Git Repository is empty.' }, commitsStatus);
      return jsonResponse([{ commit: { committer: { date: '2024-06-01T00:00:00Z' } } }], 200, {
        link: '<https://api.github.com/repos/me/demo/commits?per_page=1&page=12>; rel="last"',
      });
    }
    if (url === 'https://api.github.com/repos/me/demo/commits?per_page=1&page=12') {
      return jsonResponse([{ commit: { committer: { date: '2023-01-01T00:00:00Z' } } }]);
    }
    if (url === 'https://api.github.com/user') {
      return jsonResponse(login ? { login } : {});
    }
    if (url === `https://api.github.com/repos/me/demo/commits?author=${login}&per_page=1`) {
      return jsonResponse([{ commit: { committer: { date: '2024-06-01T00:00:00Z' } } }], 200, {
        link: `<https://api.github.com/repos/me/demo/commits?author=${login}&per_page=1&page=7>; rel="last"`,
      });
    }
    if (url === 'https://api.github.com/repos/me/demo/readme') {
      return jsonResponse({
        content: base64(readmeContent),
        html_url: 'https://github.com/me/demo/blob/main/README.md',
      });
    }
    if (url.startsWith('https://api.github.com/repos/me/demo/contents/')) {
      const path = url.slice('https://api.github.com/repos/me/demo/contents/'.length);
      if (path === manifestPath) {
        return jsonResponse({
          content: base64('{"name":"demo"}'),
          html_url: `https://github.com/me/demo/blob/main/${path}`,
        });
      }
      return jsonResponse({ message: 'Not Found' }, 404);
    }
    throw new Error(`Unexpected URL ${url}`);
  };
}

describe('readRepoEvidence', () => {
  it('fills tier 1 fields, and leaves tier 2 fields absent', async () => {
    routeFetch(makeEvidenceRouter());
    const evidence = await readRepoEvidence('tok', 'me/demo', { tiers: [1] });

    expect(evidence.repo).toEqual({
      value: {
        name: 'demo',
        fullName: 'me/demo',
        description: 'A demo repo',
        visibility: 'public',
        pushedAt: '2024-06-01T00:00:00Z',
        stars: 42,
      },
      url: 'https://api.github.com/repos/me/demo',
    });
    expect(evidence.topics?.value).toEqual(['cli', 'tools']);
    expect(evidence.languages?.value).toEqual({ TypeScript: 1000, JavaScript: 200 });
    expect(evidence.commits?.value).toEqual({
      firstCommitAt: '2023-01-01T00:00:00Z',
      lastCommitAt: '2024-06-01T00:00:00Z',
      authoredByUserCount: 7,
    });

    expect(evidence.readme).toBeUndefined();
    expect(evidence.manifest).toBeUndefined();
  });

  it('fills tier 2 fields, and leaves tier 1 fields absent', async () => {
    routeFetch(makeEvidenceRouter());
    const evidence = await readRepoEvidence('tok', 'me/demo', { tiers: [2] });

    expect(evidence.readme).toEqual({
      value: '# Demo\n\nSome text.',
      url: 'https://github.com/me/demo/blob/main/README.md',
    });
    expect(evidence.manifest).toEqual({
      value: { path: 'package.json', content: '{"name":"demo"}' },
      url: 'https://github.com/me/demo/blob/main/package.json',
    });

    expect(evidence.repo).toBeUndefined();
    expect(evidence.languages).toBeUndefined();
    expect(evidence.topics).toBeUndefined();
    expect(evidence.commits).toBeUndefined();
  });

  it('falls through the manifest candidates in order', async () => {
    routeFetch(makeEvidenceRouter({ manifestPath: 'go.mod' }));
    const evidence = await readRepoEvidence('tok', 'me/demo', { tiers: [2] });
    expect(evidence.manifest?.value.path).toBe('go.mod');
  });

  it('omits the manifest when none of the candidates exist', async () => {
    routeFetch(makeEvidenceRouter({ manifestPath: null }));
    const evidence = await readRepoEvidence('tok', 'me/demo', { tiers: [2] });
    expect(evidence.manifest).toBeUndefined();
  });

  it('decodes the README from base64 and caps it in bytes', async () => {
    const long = 'é'.repeat(10_000); // multi-byte, so byte length != character length
    routeFetch(makeEvidenceRouter({ readmeContent: long, manifestPath: null }));
    const evidence = await readRepoEvidence('tok', 'me/demo', { tiers: [2] });
    const readme = evidence.readme!.value;
    expect(readme.length).toBeGreaterThan(0);
    expect(readme.length).toBeLessThan(long.length);
    expect(new TextEncoder().encode(readme).length).toBeLessThanOrEqual(8_000);
  });

  it('cuts cleanly when the byte cap lands inside a multi-byte character', async () => {
    // 7,999 ASCII bytes followed by three-byte "€" characters: the 8,000-byte
    // cut lands on the first continuation byte of the first "€", so a naive
    // slice-then-decode would turn it into a stray U+FFFD over the cap.
    const content = 'a'.repeat(7_999) + '€'.repeat(5);
    routeFetch(makeEvidenceRouter({ readmeContent: content, manifestPath: null }));
    const evidence = await readRepoEvidence('tok', 'me/demo', { tiers: [2] });
    const readme = evidence.readme!.value;
    expect(readme).toBe('a'.repeat(7_999));
    expect(new TextEncoder().encode(readme).length).toBeLessThanOrEqual(8_000);
  });

  it('reports no commits for an empty repository (409) instead of a network error', async () => {
    routeFetch(makeEvidenceRouter({ commitsStatus: 409 }));
    const evidence = await readRepoEvidence('tok', 'me/demo', { tiers: [1] });
    expect(evidence.commits?.value).toEqual({
      firstCommitAt: null,
      lastCommitAt: null,
      authoredByUserCount: 0,
    });
  });

  it('throws rather than silently counting every commit when GitHub returns no login', async () => {
    routeFetch(makeEvidenceRouter({ login: null }));
    await expect(readRepoEvidence('tok', 'me/demo', { tiers: [1] })).rejects.toThrow(/login/i);
  });

  it('skips GET /user when the login is already known, so reading many repos costs one fewer request each', async () => {
    routeFetch(makeEvidenceRouter());
    const evidence = await readRepoEvidence('tok', 'me/demo', { tiers: [1], login: 'me' });
    expect(evidence.commits?.value.authoredByUserCount).toBe(7);
    expect(captured.some((c) => c.url === 'https://api.github.com/user')).toBe(false);
  });

  it('throws for tier 3 and tier 4 without making any request', async () => {
    vi.stubGlobal('fetch', () => {
      throw new Error('fetch should not be called for unimplemented tiers');
    });
    await expect(readRepoEvidence('tok', 'me/demo', { tiers: [3] })).rejects.toThrow(/not implemented/i);
    await expect(readRepoEvidence('tok', 'me/demo', { tiers: [4] })).rejects.toThrow(/not implemented/i);
    await expect(readRepoEvidence('tok', 'me/demo', { tiers: [1, 4] })).rejects.toThrow(/not implemented/i);
  });
});
