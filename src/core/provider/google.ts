import {
  ProviderError,
  extractJson,
  type CompletionRequest,
  type CompletionResult,
  type LLMProvider,
  type ProviderConfig,
  type ProviderInfo,
} from './types';

/**
 * Google Gemini provider. The Generative Language API serves permissive CORS
 * for browser origins, so no special flag is required — but the key is still
 * exposed to page scripts, which the key-entry screen says outright.
 */

const info: ProviderInfo = {
  id: 'google',
  label: 'Google Gemini',
  keyUrl: 'https://aistudio.google.com/apikey',
  keyPrefix: 'AIza',
  models: [
    { id: 'gemini-3-pro', label: 'Gemini 3 Pro' },
    { id: 'gemini-3-flash', label: 'Gemini 3 Flash', note: 'Cheaper and faster.' },
  ],
  defaultModel: 'gemini-3-pro',
  browserNote:
    'Google serves CORS for browser origins directly. Restrict the key to your deployed origin in AI Studio.',
};

/**
 * Gemini's `responseSchema` rejects the JSON Schema keywords `$ref`, `$defs`
 * and `additionalProperties`, so the shared schema is inlined and stripped
 * before it is sent. Everything else about the contract is identical.
 */
function toGeminiSchema(schema: unknown): unknown {
  const defs = (schema as { $defs?: Record<string, unknown> }).$defs ?? {};

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;

    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === 'string') {
      const key = obj.$ref.replace('#/$defs/', '');
      return walk(defs[key]);
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'additionalProperties' || k === '$defs') continue;
      out[k] = walk(v);
    }
    return out;
  };

  return walk(schema);
}

export const googleProvider: LLMProvider = {
  info,

  async complete(req: CompletionRequest, cfg: ProviderConfig): Promise<CompletionResult> {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: cfg.apiKey });

    try {
      const stream = await client.models.generateContentStream({
        model: cfg.model,
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        config: {
          systemInstruction: req.system,
          maxOutputTokens: req.maxTokens ?? 16000,
          abortSignal: req.signal,
          ...(req.jsonSchema
            ? {
                responseMimeType: 'application/json',
                responseSchema: toGeminiSchema(req.jsonSchema.schema) as never,
              }
            : {}),
        },
      });

      let text = '';
      let usage: CompletionResult['usage'];
      for await (const chunk of stream) {
        const delta = chunk.text ?? '';
        if (delta) {
          text += delta;
          req.onToken?.(delta);
        }
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount,
            outputTokens: chunk.usageMetadata.candidatesTokenCount,
          };
        }
      }

      return {
        text,
        json: req.jsonSchema ? extractJson(text) : undefined,
        usage,
        model: cfg.model,
      };
    } catch (err) {
      throw toProviderError(err);
    }
  },
};

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = (err as { message?: string } | null)?.message ?? 'Gemini request failed.';
  if (/api[_ ]key|permission|unauthenticated/i.test(message)) {
    return new ProviderError('Google rejected the API key.', err, 'auth');
  }
  if (/quota|rate|resource_exhausted/i.test(message)) {
    return new ProviderError('Google rate-limited the request. Wait and retry.', err, 'rate-limit');
  }
  return new ProviderError(message, err);
}
