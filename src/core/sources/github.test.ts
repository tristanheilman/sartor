import { describe, it, expect, afterEach, vi } from 'vitest';
import { listRepos, readRepoEvidence, GitHubError } from './github';

/**
 * Intercepts `fetch` the way `provider.test.ts` does: no real network, no
 * token. Pins the request shape (headers, query, pagination) and the error
 * mapping, since an API change here would otherwise only surface as a
 * confusing failure in a user's browser.
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

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Routes each captured request to a handler keyed by a substring of the URL. */
function stubRoutes(routes: Array<[string, () => Response]>) {
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    capture(input, init);
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    const route = routes.find(([match]) => url.includes(match));
    if (!route) throw new Error(`Unhandled test fetch: ${url}`);
    return Promise.resolve(route[1]());
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  captured.length = 0;
});

const TOKEN = 'github_pat_test';

describe('listRepos', () => {
  it('sends the auth, accept and API-version headers, and the owner-affiliation query', async () => {
    stubRoutes([['/user/repos', () => jsonResponse([])]]);
    await listRepos(TOKEN);

    expect(captured[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(captured[0]!.headers.accept).toBe('application/vnd.github+json');
    expect(captured[0]!.headers['x-github-api-version']).toBe('2022-11-28');
    expect(captured[0]!.url).toContain('affiliation=owner');
  });

  it('maps the fields the issue asks for', async () => {
    stubRoutes([
      [
        '/user/repos',
        () =>
          jsonResponse([
            {
              name: 'sartor',
              full_name: 'tristanheilman/sartor',
              description: 'Resume tailoring',
              visibility: 'public',
              pushed_at: '2026-01-01T00:00:00Z',
              html_url: 'https://github.com/tristanheilman/sartor',
            },
          ]),
      ],
    ]);
    const repos = await listRepos(TOKEN);
    expect(repos).toEqual([
      {
        name: 'sartor',
        fullName: 'tristanheilman/sartor',
        description: 'Resume tailoring',
        visibility: 'public',
        pushedAt: '2026-01-01T00:00:00Z',
        url: 'https://github.com/tristanheilman/sartor',
      },
    ]);
  });

  it('follows the Link header across pages', async () => {
    let call = 0;
    vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
      capture(input, init);
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          jsonResponse([{ name: 'one', full_name: 'me/one', pushed_at: 'x', html_url: 'u1', private: false }], {
            headers: {
              'content-type': 'application/json',
              link: '<https://api.github.com/user/repos?page=2>; rel="next"',
            },
          }),
        );
      }
      return Promise.resolve(
        jsonResponse([{ name: 'two', full_name: 'me/two', pushed_at: 'y', html_url: 'u2', private: true }]),
      );
    });

    const repos = await listRepos(TOKEN);
    expect(repos.map((r) => r.name)).toEqual(['one', 'two']);
    expect(repos[1]!.visibility).toBe('private');
    expect(captured).toHaveLength(2);
    expect(captured[1]!.url).toBe('https://api.github.com/user/repos?page=2');
  });

  it('maps a 401 to a typed auth error', async () => {
    stubRoutes([['/user/repos', () => new Response(null, { status: 401 })]]);
    await expect(listRepos(TOKEN)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a rate-limited 403 to a typed rate-limit error', async () => {
    stubRoutes([
      [
        '/user/repos',
        () => new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      ],
    ]);
    await expect(listRepos(TOKEN)).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps a 404 to a typed not-found error', async () => {
    stubRoutes([['/user/repos', () => new Response(null, { status: 404 })]]);
    await expect(listRepos(TOKEN)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('maps a network-level throw to a typed network error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await expect(listRepos(TOKEN)).rejects.toBeInstanceOf(GitHubError);
    await expect(listRepos(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('readRepoEvidence', () => {
  function stubTier1And2() {
    stubRoutes([
      [
        '/repos/me/proj/languages',
        () => jsonResponse({ TypeScript: 1000, JavaScript: 10 }),
      ],
      [
        '/repos/me/proj/readme',
        () =>
          jsonResponse({
            content: Buffer.from('# Hello\n\nA project.').toString('base64'),
            html_url: 'https://github.com/me/proj/blob/main/README.md',
          }),
      ],
      [
        '/repos/me/proj/contents/package.json',
        () =>
          jsonResponse({
            content: Buffer.from('{"name":"proj"}').toString('base64'),
            html_url: 'https://github.com/me/proj/blob/main/package.json',
          }),
      ],
      [
        '/user',
        () => jsonResponse({ login: 'me' }),
      ],
      [
        'page=12',
        () => jsonResponse([{ commit: { author: { date: '2025-01-01T00:00:00Z' } } }]),
      ],
      [
        '/repos/me/proj/commits',
        () =>
          jsonResponse([{ commit: { author: { date: '2026-02-01T00:00:00Z' } } }], {
            headers: {
              'content-type': 'application/json',
              link: '<https://api.github.com/repos/me/proj/commits?author=me&per_page=1&page=12>; rel="last"',
            },
          }),
      ],
      [
        '/repos/me/proj',
        () =>
          jsonResponse({
            name: 'proj',
            full_name: 'me/proj',
            description: 'A project',
            visibility: 'public',
            pushed_at: '2026-03-01T00:00:00Z',
            stargazers_count: 7,
            topics: ['typescript', 'resume'],
          }),
      ],
    ]);
  }

  it('populates only tier 1 when tier 2 is not requested', async () => {
    stubTier1And2();
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [1] });

    expect(evidence.repo).toEqual({
      url: 'https://api.github.com/repos/me/proj',
      value: {
        name: 'proj',
        fullName: 'me/proj',
        description: 'A project',
        visibility: 'public',
        pushedAt: '2026-03-01T00:00:00Z',
        stars: 7,
        topics: ['typescript', 'resume'],
      },
    });
    expect(evidence.languages).toEqual({
      url: 'https://api.github.com/repos/me/proj/languages',
      value: { TypeScript: 1000, JavaScript: 10 },
    });
    expect(evidence.commits).toEqual({
      url: 'https://api.github.com/repos/me/proj/commits?author=me&per_page=1',
      value: {
        firstCommitDate: '2025-01-01T00:00:00Z',
        lastCommitDate: '2026-02-01T00:00:00Z',
        authoredCommitCount: 12,
      },
    });
    expect(evidence.readme).toBeNull();
    expect(evidence.manifest).toBeNull();
  });

  it('populates only tier 2 when tier 1 is not requested', async () => {
    stubTier1And2();
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [2] });

    expect(evidence.repo).toBeNull();
    expect(evidence.languages).toBeNull();
    expect(evidence.commits).toBeNull();
    expect(evidence.readme).toEqual({
      url: 'https://github.com/me/proj/blob/main/README.md',
      value: '# Hello\n\nA project.',
    });
    expect(evidence.manifest).toEqual({
      url: 'https://github.com/me/proj/blob/main/package.json',
      value: { path: 'package.json', content: '{"name":"proj"}' },
    });
  });

  it('caps the README at the byte cap', async () => {
    stubRoutes([
      [
        '/readme',
        () => jsonResponse({ content: Buffer.from('x'.repeat(30_000)).toString('base64'), html_url: 'u' }),
      ],
      ['/contents/', () => new Response(null, { status: 404 })],
    ]);
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [2] });
    expect(evidence.readme!.value.length).toBeLessThanOrEqual(20_000);
  });

  it('tries manifest candidates in order and stops at the first match', async () => {
    stubRoutes([
      ['/readme', () => new Response(null, { status: 404 })],
      ['/contents/package.json', () => new Response(null, { status: 404 })],
      [
        '/contents/pyproject.toml',
        () => jsonResponse({ content: Buffer.from('[tool.poetry]').toString('base64'), html_url: 'u' }),
      ],
    ]);
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [2] });
    expect(evidence.manifest).toEqual({ url: 'u', value: { path: 'pyproject.toml', content: '[tool.poetry]' } });
  });

  it('returns a null readme and manifest when neither exists', async () => {
    stubRoutes([['', () => new Response(null, { status: 404 })]]);
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [2] });
    expect(evidence.readme).toBeNull();
    expect(evidence.manifest).toBeNull();
  });

  it('throws when tier 3 is requested', async () => {
    await expect(readRepoEvidence(TOKEN, 'me/proj', { tiers: [1, 3] })).rejects.toThrow(/not implemented/);
  });

  it('throws when tier 4 is requested', async () => {
    await expect(readRepoEvidence(TOKEN, 'me/proj', { tiers: [4] })).rejects.toThrow(/not implemented/);
  });

  it('never makes a request outside api.github.com', async () => {
    stubTier1And2();
    await readRepoEvidence(TOKEN, 'me/proj', { tiers: [1, 2] });
    for (const req of captured) {
      expect(req.url.startsWith('https://api.github.com/')).toBe(true);
    }
  });
});
