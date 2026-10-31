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
  signal: AbortSignal | null | undefined;
}

const captured: Captured[] = [];

function capture(input: unknown, init: RequestInit | undefined) {
  const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (input as Request)?.headers).forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  captured.push({ url, headers, signal: init?.signal });
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

  it('maps a secondary-limited 403 (Retry-After, no exhausted primary limit) to rate-limit, not auth', async () => {
    stubRoutes([
      ['/user/repos', () => new Response(null, { status: 403, headers: { 'retry-after': '30' } })],
    ]);
    await expect(listRepos(TOKEN)).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps a plain 403 with neither signal to auth', async () => {
    stubRoutes([['/user/repos', () => new Response(null, { status: 403 })]]);
    await expect(listRepos(TOKEN)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps a 429 to rate-limit, not network', async () => {
    stubRoutes([['/user/repos', () => new Response(null, { status: 429 })]]);
    await expect(listRepos(TOKEN)).rejects.toMatchObject({ kind: 'rate-limit' });
  });

  it('maps a network-level throw to a typed network error', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    await expect(listRepos(TOKEN)).rejects.toBeInstanceOf(GitHubError);
    await expect(listRepos(TOKEN)).rejects.toMatchObject({ kind: 'network' });
  });

  it('lets an abort from the caller propagate as-is, not wrapped as a network error', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', () => {
      controller.abort();
      return Promise.reject(abortError);
    });
    await expect(listRepos(TOKEN, { signal: controller.signal })).rejects.toBe(abortError);
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
      ['/repos/me/proj/contents/', () => new Response(null, { status: 404 })],
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
    expect(evidence.manifests).toEqual([]);
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
    expect(evidence.manifests).toEqual([
      {
        url: 'https://github.com/me/proj/blob/main/package.json',
        value: { path: 'package.json', content: '{"name":"proj"}' },
      },
    ]);
  });

  it('caps the README at the byte cap, without splitting a multi-byte character', async () => {
    // "é" is two bytes in UTF-8, so a naive character-count cap would pass
    // while still letting the byte length exceed the cap.
    const oversized = 'é'.repeat(15_000);
    stubRoutes([
      ['/readme', () => jsonResponse({ content: Buffer.from(oversized, 'utf-8').toString('base64'), html_url: 'u' })],
      ['/contents/', () => new Response(null, { status: 404 })],
    ]);
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [2] });
    const byteLength = new TextEncoder().encode(evidence.readme!.value).length;
    expect(byteLength).toBeLessThanOrEqual(20_000);
    expect(evidence.readme!.value.length).toBeLessThan(oversized.length);
  });

  it('collects every manifest present, not just the first match', async () => {
    stubRoutes([
      ['/readme', () => new Response(null, { status: 404 })],
      [
        '/contents/package.json',
        () => jsonResponse({ content: Buffer.from('{"name":"proj"}').toString('base64'), html_url: 'u-package' }),
      ],
      ['/contents/pyproject.toml', () => new Response(null, { status: 404 })],
      [
        '/contents/go.mod',
        () => jsonResponse({ content: Buffer.from('module proj').toString('base64'), html_url: 'u-gomod' }),
      ],
      ['/contents/Cargo.toml', () => new Response(null, { status: 404 })],
    ]);
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [2] });
    expect(evidence.manifests).toEqual([
      { url: 'u-package', value: { path: 'package.json', content: '{"name":"proj"}' } },
      { url: 'u-gomod', value: { path: 'go.mod', content: 'module proj' } },
    ]);
  });

  it('returns a null readme and no manifests when neither exists', async () => {
    stubRoutes([['', () => new Response(null, { status: 404 })]]);
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [2] });
    expect(evidence.readme).toBeNull();
    expect(evidence.manifests).toEqual([]);
  });

  it('caps each manifest at the byte cap', async () => {
    stubRoutes([
      ['/readme', () => new Response(null, { status: 404 })],
      [
        '/contents/package.json',
        () => jsonResponse({ content: Buffer.from('x'.repeat(30_000)).toString('base64'), html_url: 'u' }),
      ],
      ['/contents/', () => new Response(null, { status: 404 })],
    ]);
    const evidence = await readRepoEvidence(TOKEN, 'me/proj', { tiers: [2] });
    const byteLength = new TextEncoder().encode(evidence.manifests[0]!.value.content).length;
    expect(byteLength).toBeLessThanOrEqual(20_000);
  });

  it('reports a repository with no commits yet as a zero-commit summary, not a failure', async () => {
    stubRoutes([
      ['/repos/me/empty/languages', () => jsonResponse({})],
      ['/commits', () => new Response(null, { status: 409 })],
      ['/user', () => jsonResponse({ login: 'me' })],
      [
        '/repos/me/empty',
        () =>
          jsonResponse({
            name: 'empty',
            full_name: 'me/empty',
            description: null,
            visibility: 'public',
            pushed_at: '2026-01-01T00:00:00Z',
            stargazers_count: 0,
            topics: [],
          }),
      ],
    ]);
    const evidence = await readRepoEvidence(TOKEN, 'me/empty', { tiers: [1] });
    expect(evidence.commits!.value).toEqual({
      firstCommitDate: null,
      lastCommitDate: null,
      authoredCommitCount: 0,
    });
  });

  it('forwards an AbortSignal to every request it makes', async () => {
    stubTier1And2();
    const controller = new AbortController();
    await readRepoEvidence(TOKEN, 'me/proj', { tiers: [1, 2], signal: controller.signal });

    expect(captured.length).toBeGreaterThan(0);
    for (const call of captured) {
      expect(call.signal).toBe(controller.signal);
    }
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
