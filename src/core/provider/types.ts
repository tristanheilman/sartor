/**
 * The single seam through which all model access happens.
 *
 * Every provider — and, later, a hosted server-key mode — implements this one
 * interface. Application code never imports a vendor SDK, never branches on
 * provider name, and never sees an API key. Adding a provider is a new file in
 * this directory plus one line in the registry; it touches no application logic.
 */

export interface ModelOption {
  id: string;
  label: string;
  /** Shown in the picker so the cost implication is not hidden from the user. */
  note?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  /** Where the user goes to create a key. */
  keyUrl: string;
  /** Expected key prefix, used only for a client-side sanity check. */
  keyPrefix?: string;
  models: ModelOption[];
  defaultModel: string;
  /**
   * The honest note shown at the point of key entry, describing what this
   * provider requires in order to be called from a browser at all.
   */
  browserNote: string;
}

export interface CompletionRequest {
  system: string;
  user: string;
  /** When set, the provider must constrain output to this JSON Schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxTokens?: number;
  signal?: AbortSignal;
  /** Called with incremental text when the provider supports streaming. */
  onToken?: (chunk: string) => void;
}

export interface CompletionResult {
  text: string;
  /** Populated when `jsonSchema` was supplied and parsing succeeded. */
  json?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  model: string;
}

export interface LLMProvider {
  readonly info: ProviderInfo;
  complete(req: CompletionRequest, cfg: ProviderConfig): Promise<CompletionResult>;
}

export interface ProviderConfig {
  apiKey: string;
  model: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly kind: 'auth' | 'rate-limit' | 'network' | 'invalid-response' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Best-effort extraction of a JSON object from a text response. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some providers wrap JSON in a fenced code block despite the schema.
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        /* fall through */
      }
    }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(trimmed.slice(first, last + 1));
      } catch {
        /* fall through */
      }
    }
    throw new ProviderError('The model did not return valid JSON.', text, 'invalid-response');
  }
}
