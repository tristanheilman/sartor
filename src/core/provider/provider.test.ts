import { describe, it, expect, afterEach, vi } from 'vitest';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import { toGeminiSchema } from './google';
import { extractJson, ProviderError, type CompletionResult } from './types';
import { PROVIDERS, PROVIDER_LIST, getProvider } from './index';
import { TAILOR_PLAN_JSON_SCHEMA } from '@/core/tailor/plan';

/**
 * Provider contract tests.
 *
 * These intercept `fetch` rather than calling a real API, so they cost nothing
 * and need no key — but they pin down the parts that are otherwise only
 * typechecked: that the browser-access opt-ins are actually sent, that each
 * provider constrains output to our JSON Schema in its own dialect, and that
 * a streamed response is assembled and parsed correctly.
 *
 * The failure mode they exist to catch is an SDK upgrade silently changing a
 * request shape — which would otherwise surface as a 400 in a user's browser.
 */

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const captured: Captured[] = [];

function capture(input: unknown, init: RequestInit | undefined) {
  const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? (input as Request)?.headers).forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  captured.push({ url, headers, body });
}

function sseResponse(events: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const e of events) controller.enqueue(enc.encode(e));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function stubFetch(makeResponse: () => Response) {
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) => {
    capture(input, init);
    return Promise.resolve(makeResponse());
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  captured.length = 0;
});

/* ------------------------------------------------------------------ */

describe('registry', () => {
  it('exposes exactly the three shipped providers', () => {
    expect(Object.keys(PROVIDERS)).toEqual(['anthropic', 'openai', 'google']);
    expect(PROVIDER_LIST).toHaveLength(3);
  });

  it('throws a clear error for an unknown provider id', () => {
    expect(() => getProvider('cohere')).toThrow(/Unknown provider/);
  });

  it('gives every provider a default model that is in its own model list', () => {
    for (const p of PROVIDER_LIST) {
      expect(p.info.models.map((m) => m.id)).toContain(p.info.defaultModel);
    }
  });

  it('gives every provider an honest browser-access note', () => {
    for (const p of PROVIDER_LIST) {
      expect(p.info.browserNote.length).toBeGreaterThan(30);
      expect(p.info.keyUrl).toMatch(/^https:\/\//);
    }
  });

  it('defaults Anthropic to Claude Opus 5', () => {
    expect(anthropicProvider.info.defaultModel).toBe('claude-opus-5');
  });
});

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers JSON from a fenced code block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON surrounded by prose', () => {
    expect(extractJson('Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('throws a typed error rather than returning garbage', () => {
    expect(() => extractJson('not json at all')).toThrow(ProviderError);
    try {
      extractJson('nope');
    } catch (e) {
      expect((e as ProviderError).kind).toBe('invalid-response');
    }
  });
});

/* ------------------------------------------------------------------ */

const ANTHROPIC_SSE = [
  `event: message_start\ndata: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 42, output_tokens: 0 },
    },
  })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '{"notes":' },
  })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '"ok"}' },
  })}\n\n`,
  `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 7 },
  })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
];

describe('anthropic provider', () => {
  async function run(): Promise<CompletionResult> {
    stubFetch(() => sseResponse(ANTHROPIC_SSE));
    return anthropicProvider.complete(
      {
        system: 'SYSTEM',
        user: 'USER',
        jsonSchema: { name: 'tailor_plan', schema: TAILOR_PLAN_JSON_SCHEMA as never },
        maxTokens: 16000,
      },
      { apiKey: 'sk-ant-test', model: 'claude-opus-5' },
    );
  }

  it('sends the header Anthropic requires for browser-origin calls', async () => {
    await run();
    expect(captured[0]!.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('authenticates with x-api-key and pins the API version', async () => {
    await run();
    expect(captured[0]!.headers['x-api-key']).toBe('sk-ant-test');
    expect(captured[0]!.headers['anthropic-version']).toBeTruthy();
  });

  it('constrains output to our JSON Schema', async () => {
    await run();
    const oc = captured[0]!.body.output_config as Record<string, unknown>;
    const format = oc.format as Record<string, unknown>;
    expect(format.type).toBe('json_schema');
    expect(format.schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('streams, so a long plan cannot hit an HTTP timeout', async () => {
    await run();
    expect(captured[0]!.body.stream).toBe(true);
    expect(captured[0]!.body.max_tokens).toBe(16000);
  });

  it('puts the system prompt in the system field, not the user turn', async () => {
    await run();
    expect(captured[0]!.body.system).toBe('SYSTEM');
    expect(captured[0]!.body.messages).toEqual([{ role: 'user', content: 'USER' }]);
  });

  it('assembles streamed deltas and parses the result', async () => {
    const result = await run();
    expect(result.text).toBe('{"notes":"ok"}');
    expect(result.json).toEqual({ notes: 'ok' });
    expect(result.model).toBe('claude-opus-5');
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it('forwards streamed text to onToken as it arrives', async () => {
    stubFetch(() => sseResponse(ANTHROPIC_SSE));
    const chunks: string[] = [];
    await anthropicProvider.complete(
      { system: 's', user: 'u', onToken: (c) => chunks.push(c) },
      { apiKey: 'sk-ant-test', model: 'claude-opus-5' },
    );
    expect(chunks.join('')).toBe('{"notes":"ok"}');
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('maps a 401 to an auth error the UI can explain', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'bad key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(
      anthropicProvider.complete({ system: 's', user: 'u' }, { apiKey: 'bad', model: 'claude-opus-5' }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });

  it('surfaces a refusal as an error rather than an empty resume', async () => {
    const refusal = [
      ANTHROPIC_SSE[0]!,
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_sequence: null },
        usage: { output_tokens: 0 },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    stubFetch(() => sseResponse(refusal));
    await expect(
      anthropicProvider.complete({ system: 's', user: 'u' }, { apiKey: 'sk-ant-test', model: 'claude-opus-5' }),
    ).rejects.toThrow(/declined/i);
  });
});

/* ------------------------------------------------------------------ */

const OPENAI_SSE = [
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta: { content: '{"notes":' } }],
  })}\n\n`,
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta: { content: '"ok"}' } }],
  })}\n\n`,
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  })}\n\n`,
  'data: [DONE]\n\n',
];

describe('openai provider', () => {
  async function run(): Promise<CompletionResult> {
    stubFetch(() => sseResponse(OPENAI_SSE));
    return openaiProvider.complete(
      {
        system: 'SYSTEM',
        user: 'USER',
        jsonSchema: { name: 'tailor_plan', schema: TAILOR_PLAN_JSON_SCHEMA as never },
      },
      { apiKey: 'sk-test', model: 'gpt-5.1' },
    );
  }

  it('uses strict json_schema so the plan comes back parseable', async () => {
    await run();
    const rf = captured[0]!.body.response_format as Record<string, unknown>;
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema).toMatchObject({ name: 'tailor_plan', strict: true });
  });

  it('sends system and user as separate messages', async () => {
    await run();
    expect(captured[0]!.body.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'USER' },
    ]);
  });

  it('requests usage alongside the stream', async () => {
    await run();
    expect(captured[0]!.body.stream).toBe(true);
    expect(captured[0]!.body.stream_options).toEqual({ include_usage: true });
  });

  it('assembles streamed deltas, parses, and reports usage', async () => {
    const result = await run();
    expect(result.json).toEqual({ notes: 'ok' });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
  });

  it('maps a 429 to a rate-limit error', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await expect(
      openaiProvider.complete({ system: 's', user: 'u' }, { apiKey: 'sk-test', model: 'gpt-5.1' }),
    ).rejects.toMatchObject({ kind: 'rate-limit' });
  }, 20_000);
});

/* ------------------------------------------------------------------ */

describe('toGeminiSchema', () => {
  const converted = toGeminiSchema(TAILOR_PLAN_JSON_SCHEMA) as Record<string, unknown>;
  const serialised = JSON.stringify(converted);

  it('removes the keywords Gemini rejects', () => {
    expect(serialised).not.toContain('additionalProperties');
    expect(serialised).not.toContain('$defs');
    expect(serialised).not.toContain('$ref');
  });

  it('inlines $ref targets rather than dropping the branch', () => {
    // `work` is a $ref to $defs/entries in the source schema.
    const work = (converted.properties as Record<string, Record<string, unknown>>).work!;
    expect(work.type).toBe('array');
    const items = work.items as Record<string, unknown>;
    expect(Object.keys(items.properties as object)).toEqual(['id', 'include', 'order', 'bullets']);
  });

  it('inlines the same $ref at every use site', () => {
    const props = converted.properties as Record<string, Record<string, unknown>>;
    expect(JSON.stringify(props.work)).toBe(JSON.stringify(props.projects));
    expect(JSON.stringify(props.work)).toBe(JSON.stringify(props.education));
  });

  it('preserves the parts of the contract that carry meaning', () => {
    expect(converted.required).toEqual(TAILOR_PLAN_JSON_SCHEMA.required);
    const order = (converted.properties as Record<string, Record<string, unknown>>).sectionOrder!;
    expect((order.items as Record<string, unknown>).enum).toContain('work');
  });

  it('leaves a schema with no $ref or $defs structurally unchanged', () => {
    const plain = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(toGeminiSchema(plain)).toEqual(plain);
  });

  it('produces a schema that still round-trips through JSON', () => {
    expect(() => JSON.parse(serialised)).not.toThrow();
  });
});
