import { describe, it, expect, afterEach, vi } from 'vitest';
import { listRepos, readRepoEvidence, GitHubError } from './github';

/**
 * Intercepts `fetch` the way `provider/provider.test.ts` does: no network,
 * no token, but the request shape, headers and pagination are pinned down.
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

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

/** Routes each captured URL through a handler keyed by a substring match. */
function stubFetch(router: (url: string) => Response) {
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

const repoJson = {
  name: 'sartor',
  full_name: 'octocat/sartor',
  description: 'A resume tool.',
  private: false,
  pushed_at: '2026-01-01T00:00:00Z',
  html_url: 'https://github.com/octocat/sartor',
  topics: ['resume', 'typescript'],
};

describe('listRepos', () => {
  it('requests the owned-repos endpoint with the required headers', async () => {
    stubFetch((url) => {
      if (url.includes('/user/repos')) return jsonResponse([]);
      throw new Error(`unexpected url ${url}`);
    });

    await listRepos('tok');

    expect(captured[0]!.url).toBe('https://api.github.com/user/repos?affiliation=owner&per_page=100');
    expect(captured[0]!.headers.authorization).toBe('Bearer tok');
    expect(captured[0]!.headers.accept).toBe('application/vnd.github+json');
    expect(captured[0]!.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('maps fields and follows the Link header across pages', async () => {
    stubFetch((url) => {
      if (url === 'https://api.github.com/user/repos?affiliation=owner&per_page=100') {
        return jsonResponse([{ ...repoJson, name: 'one', full_name: 'octocat/one' }], {
          headers: { link: '<https://api.github.com/user/repos?affiliation=owner&per_page=100&page=2>; rel="next"' },
        });
      }
      if (url.includes('page=2')) {
        return jsonResponse([{ ...repoJson, name: 'two', full_name: 'octocat/two', private: true }]);
      }
      throw new Error(`unexpected url ${url}`);
    });

    const repos = await listRepos('tok');

    expect(repos).toEqual([
      {
        name: 'one',
        fullName: 'octocat/one',
        description: 'A resume tool.',
        visibility: 'public',
        pushedAt: '2026-01-01T00:00:00Z',
        url: 'https://github.com/octocat/sartor',
      },
      {
        name: 'two',
        fullName: 'octocat/two',
        description: 'A resume tool.',
        visibility: 'private',
        pushedAt: '2026-01-01T00:00:00Z',
        url: 'https://github.com/octocat/sartor',
      },
    ]);
    expect(captured).toHaveLength(2);
  });

  it('maps a 401 to an auth error', async () => {
    stubFetch(() => jsonResponse({ message: 'Bad credentials' }, { status: 401 }));
    await expect(listRepos('bad')).rejects.toMatchObject({ kind: 'auth' } satisfies Partial<GitHubError>);
  });

  it('maps a 403 with an exhausted rate limit to a rate-limit error', async () => {
    stubFetch(() => jsonResponse({ message: 'rate limited' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }));
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps a 403 secondary rate limit (retry-after, remaining not reported) to a rate-limit error', async () => {
    stubFetch(() => jsonResponse({ message: 'secondary rate limit' }, { status: 403, headers: { 'retry-after': '30' } }));
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps a plain 403 with no rate-limit headers to an auth error', async () => {
    stubFetch(() => jsonResponse({ message: 'Forbidden' }, { status: 403 }));
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a 404 to a not-found error', async () => {
    stubFetch(() => jsonResponse({ message: 'Not Found' }, { status: 404 }));
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('maps a network failure to a network error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(listRepos('tok')).rejects.toMatchObject({ kind: 'network' });
  });
});

function stubRepoRoutes(overrides: Partial<Record<string, Response>> = {}) {
  stubFetch((url) => {
    for (const [key, response] of Object.entries(overrides)) {
      if (url.includes(key)) return response!;
    }
    if (url === 'https://api.github.com/repos/octocat/sartor') return jsonResponse(repoJson);
    if (url.includes('/languages')) return jsonResponse({ TypeScript: 1000, HTML: 10 });
    if (url === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' });
    if (url === 'https://api.github.com/repos/octocat/sartor/commits?per_page=1&page=5') {
      return jsonResponse([{ commit: { author: { date: '2025-01-01T00:00:00Z' } } }]);
    }
    if (url.includes('/commits?per_page=1') && !url.includes('author=')) {
      return jsonResponse([{ commit: { author: { date: '2026-01-01T00:00:00Z' } } }], {
        headers: { link: '<https://api.github.com/repos/octocat/sartor/commits?per_page=1&page=5>; rel="last"' },
      });
    }
    if (url.includes('author=octocat')) {
      return jsonResponse([{ commit: { author: { date: '2026-01-01T00:00:00Z' } } }], {
        headers: { link: '<https://api.github.com/repos/octocat/sartor/commits?author=octocat&per_page=1&page=12>; rel="last"' },
      });
    }
    if (url.includes('/readme')) {
      return jsonResponse({
        content: Buffer.from('# Sartor\n\nA resume tool.').toString('base64'),
        html_url: 'https://github.com/octocat/sartor/blob/main/README.md',
      });
    }
    if (url.includes('/contents/package.json')) {
      return jsonResponse({
        content: Buffer.from('{"name":"sartor"}').toString('base64'),
        html_url: 'https://github.com/octocat/sartor/blob/main/package.json',
      });
    }
    if (url.includes('/contents/')) return jsonResponse({ message: 'Not Found' }, { status: 404 });
    throw new Error(`unexpected url ${url}`);
  });
}

describe('readRepoEvidence', () => {
  it('fills only tier 1 fields when tier 2 is not requested', async () => {
    stubRepoRoutes();

    const evidence = await readRepoEvidence('tok', 'octocat/sartor', { tiers: [1] });

    expect(evidence.repo).toEqual({
      name: 'sartor',
      fullName: 'octocat/sartor',
      description: 'A resume tool.',
      visibility: 'public',
      pushedAt: '2026-01-01T00:00:00Z',
      url: 'https://github.com/octocat/sartor',
    });
    expect(evidence.languages).toEqual({ names: ['TypeScript', 'HTML'], url: 'https://api.github.com/repos/octocat/sartor/languages' });
    expect(evidence.topics).toEqual({ names: ['resume', 'typescript'], url: 'https://github.com/octocat/sartor' });
    expect(evidence.commits).toEqual({
      firstCommitDate: '2025-01-01T00:00:00Z',
      lastCommitDate: '2026-01-01T00:00:00Z',
      authorCommitCount: 12,
      url: 'https://api.github.com/repos/octocat/sartor/commits?per_page=1',
    });
    expect(evidence.readme).toBeNull();
    expect(evidence.manifest).toBeNull();
  });

  it('adds the decoded README and manifest when tier 2 is requested', async () => {
    stubRepoRoutes();

    const evidence = await readRepoEvidence('tok', 'octocat/sartor', { tiers: [1, 2] });

    expect(evidence.readme).toEqual({
      text: '# Sartor\n\nA resume tool.',
      truncated: false,
      url: 'https://github.com/octocat/sartor/blob/main/README.md',
    });
    expect(evidence.manifest).toEqual([
      {
        filename: 'package.json',
        text: '{"name":"sartor"}',
        truncated: false,
        url: 'https://github.com/octocat/sartor/blob/main/package.json',
      },
    ]);
  });

  it('collects every manifest candidate present, not only the first', async () => {
    stubFetch((url) => {
      if (url === 'https://api.github.com/repos/octocat/sartor') return jsonResponse(repoJson);
      if (url.includes('/contents/package.json')) {
        return jsonResponse({
          content: Buffer.from('{"name":"sartor"}').toString('base64'),
          html_url: 'https://github.com/octocat/sartor/blob/main/package.json',
        });
      }
      if (url.includes('/contents/pyproject.toml')) {
        return jsonResponse({
          content: Buffer.from('[tool.poetry]\nname = "sartor"').toString('base64'),
          html_url: 'https://github.com/octocat/sartor/blob/main/pyproject.toml',
        });
      }
      if (url.includes('/contents/')) return jsonResponse({ message: 'Not Found' }, { status: 404 });
      if (url.includes('/readme')) return jsonResponse({ message: 'Not Found' }, { status: 404 });
      throw new Error(`unexpected url ${url}`);
    });

    const evidence = await readRepoEvidence('tok', 'octocat/sartor', { tiers: [2] });

    expect(evidence.manifest).toEqual([
      {
        filename: 'package.json',
        text: '{"name":"sartor"}',
        truncated: false,
        url: 'https://github.com/octocat/sartor/blob/main/package.json',
      },
      {
        filename: 'pyproject.toml',
        text: '[tool.poetry]\nname = "sartor"',
        truncated: false,
        url: 'https://github.com/octocat/sartor/blob/main/pyproject.toml',
      },
    ]);
  });

  it('caps the README at a byte limit and reports truncation', async () => {
    const long = 'a'.repeat(30_000);
    stubRepoRoutes({
      '/readme': jsonResponse({
        content: Buffer.from(long).toString('base64'),
        html_url: 'https://github.com/octocat/sartor/blob/main/README.md',
      }),
    });

    const evidence = await readRepoEvidence('tok', 'octocat/sartor', { tiers: [2] });

    expect(evidence.readme!.truncated).toBe(true);
    expect(evidence.readme!.text.length).toBeLessThan(long.length);
  });

  it('requests no tier-1 fields when only tier 2 is asked for', async () => {
    stubRepoRoutes();

    const evidence = await readRepoEvidence('tok', 'octocat/sartor', { tiers: [2] });

    expect(evidence.languages).toBeNull();
    expect(evidence.topics).toBeNull();
    expect(evidence.commits).toBeNull();
    expect(captured.some((c) => c.url.includes('/languages'))).toBe(false);
    expect(captured.some((c) => c.url.includes('/commits'))).toBe(false);
  });

  it('treats a 409 on the commits endpoint as an empty repo, not an error', async () => {
    stubFetch((url) => {
      if (url === 'https://api.github.com/repos/octocat/sartor') return jsonResponse(repoJson);
      if (url.includes('/languages')) return jsonResponse({});
      if (url === 'https://api.github.com/user') return jsonResponse({ login: 'octocat' });
      if (url.includes('/commits')) return jsonResponse({ message: 'Git Repository is empty.' }, { status: 409 });
      throw new Error(`unexpected url ${url}`);
    });

    const evidence = await readRepoEvidence('tok', 'octocat/sartor', { tiers: [1] });

    expect(evidence.commits).toEqual({
      firstCommitDate: null,
      lastCommitDate: null,
      authorCommitCount: 0,
      url: 'https://api.github.com/repos/octocat/sartor/commits?per_page=1',
    });
  });

  it('throws when tier 3 is requested', async () => {
    await expect(readRepoEvidence('tok', 'octocat/sartor', { tiers: [3] })).rejects.toThrow(/not implemented/);
  });

  it('throws when tier 4 is requested', async () => {
    await expect(readRepoEvidence('tok', 'octocat/sartor', { tiers: [4] })).rejects.toThrow(/not implemented/);
  });

  it('sends the required headers on the repo request', async () => {
    stubRepoRoutes();
    await readRepoEvidence('tok', 'octocat/sartor', { tiers: [1] });

    const repoCall = captured.find((c) => c.url === 'https://api.github.com/repos/octocat/sartor')!;
    expect(repoCall.headers.authorization).toBe('Bearer tok');
    expect(repoCall.headers.accept).toBe('application/vnd.github+json');
    expect(repoCall.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('never requests anything outside api.github.com', async () => {
    stubRepoRoutes();
    await readRepoEvidence('tok', 'octocat/sartor', { tiers: [1, 2] });
    for (const c of captured) {
      expect(c.url.startsWith('https://api.github.com/')).toBe(true);
    }
  });
});
