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
 * OpenAI provider. Calls go browser -> api.openai.com, which requires
 * `dangerouslyAllowBrowser` on the SDK.
 */

const info: ProviderInfo = {
  id: 'openai',
  label: 'OpenAI',
  keyUrl: 'https://platform.openai.com/api-keys',
  keyPrefix: 'sk-',
  models: [
    { id: 'gpt-5.1', label: 'GPT-5.1' },
    { id: 'gpt-5.1-mini', label: 'GPT-5.1 mini', note: 'Cheaper and faster.' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
  ],
  defaultModel: 'gpt-5.1',
  browserNote:
    'Requires the dangerouslyAllowBrowser flag on the OpenAI SDK, which is how the SDK acknowledges the key is exposed to page scripts.',
};

export const openaiProvider: LLMProvider = {
  info,

  async complete(req: CompletionRequest, cfg: ProviderConfig): Promise<CompletionResult> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: cfg.apiKey, dangerouslyAllowBrowser: true });

    try {
      const stream = await client.chat.completions.create(
        {
          model: cfg.model,
          max_completion_tokens: req.maxTokens ?? 16000,
          stream: true,
          stream_options: { include_usage: true },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          ...(req.jsonSchema
            ? {
                response_format: {
                  type: 'json_schema' as const,
                  json_schema: {
                    name: req.jsonSchema.name,
                    schema: req.jsonSchema.schema as Record<string, unknown>,
                    strict: true,
                  },
                },
              }
            : {}),
        },
        { signal: req.signal },
      );

      let text = '';
      let usage: CompletionResult['usage'];
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          text += delta;
          req.onToken?.(delta);
        }
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
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
  const status = (err as { status?: number } | null)?.status;
  const message = (err as { message?: string } | null)?.message ?? 'OpenAI request failed.';
  if (status === 401) return new ProviderError('OpenAI rejected the API key.', err, 'auth');
  if (status === 429) {
    return new ProviderError('OpenAI rate-limited the request. Wait and retry.', err, 'rate-limit');
  }
  if (status === undefined) return new ProviderError(`Could not reach OpenAI. (${message})`, err, 'network');
  return new ProviderError(message, err);
}
