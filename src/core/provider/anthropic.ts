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
 * Anthropic provider.
 *
 * Calls go straight from the user's browser to api.anthropic.com. That requires
 * two opt-ins, both of which are stated plainly at the point of key entry rather
 * than buried: `dangerouslyAllowBrowser` on the SDK, and the
 * `anthropic-dangerous-direct-browser-access` header, which is what makes
 * Anthropic serve the CORS preflight for a browser origin.
 *
 * The name of that flag is a fair warning: a key in a browser is readable by any
 * script on the page. That is the trade this whole application makes — no
 * server ever sees the key or the resume — and the README argues for it
 * explicitly rather than pretending the trade does not exist.
 */

const info: ProviderInfo = {
  id: 'anthropic',
  label: 'Anthropic',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  keyPrefix: 'sk-ant-',
  models: [
    { id: 'claude-opus-5', label: 'Claude Opus 5', note: 'Best judgement on what to cut. Highest cost.' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', note: 'Strong and noticeably cheaper.' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Fastest and cheapest.' },
  ],
  defaultModel: 'claude-opus-5',
  browserNote:
    'Requires the anthropic-dangerous-direct-browser-access header, which Anthropic requires for any call made from a browser origin.',
};

export const anthropicProvider: LLMProvider = {
  info,

  async complete(req: CompletionRequest, cfg: ProviderConfig): Promise<CompletionResult> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');

    const client = new Anthropic({
      apiKey: cfg.apiKey,
      dangerouslyAllowBrowser: true,
      defaultHeaders: { 'anthropic-dangerous-direct-browser-access': 'true' },
    });

    // Structured outputs give us schema-constrained decoding, so the plan comes
    // back parseable rather than "usually parseable".
    const outputConfig = req.jsonSchema
      ? { effort: 'medium' as const, format: { type: 'json_schema' as const, schema: req.jsonSchema.schema } }
      : { effort: 'medium' as const };

    try {
      const stream = client.messages.stream({
        model: cfg.model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: outputConfig,
      });

      if (req.onToken) stream.on('text', (delta) => req.onToken?.(delta));
      req.signal?.addEventListener('abort', () => stream.abort(), { once: true });

      const message = await stream.finalMessage();

      if (message.stop_reason === 'refusal') {
        throw new ProviderError(
          'The model declined this request. Nothing was generated.',
          message.stop_details,
          'invalid-response',
        );
      }

      const text = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');

      return {
        text,
        json: req.jsonSchema ? extractJson(text) : undefined,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
        model: message.model,
      };
    } catch (err) {
      throw toProviderError(err);
    }
  },
};

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const status = (err as { status?: number } | null)?.status;
  const message = (err as { message?: string } | null)?.message ?? 'Anthropic request failed.';
  if (status === 401 || status === 403) {
    return new ProviderError('Anthropic rejected the API key.', err, 'auth');
  }
  if (status === 429) {
    return new ProviderError('Anthropic rate-limited the request. Wait and retry.', err, 'rate-limit');
  }
  if (status === undefined) {
    return new ProviderError(
      `Could not reach Anthropic. If this is a CORS error, the key may be scoped in a way that blocks browser access. (${message})`,
      err,
      'network',
    );
  }
  return new ProviderError(message, err);
}
