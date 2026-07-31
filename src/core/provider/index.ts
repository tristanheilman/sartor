import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import { googleProvider } from './google';
import type { LLMProvider } from './types';

/**
 * The provider registry.
 *
 * Adding a provider means adding one file and one entry here. Nothing in
 * `core/tailor`, `core/parse`, `core/render`, or the UI knows which provider is
 * in use. A future hosted mode — where a server holds the key — is just another
 * implementation of `LLMProvider`, not a rewrite.
 */
export const PROVIDERS: Record<string, LLMProvider> = {
  [anthropicProvider.info.id]: anthropicProvider,
  [openaiProvider.info.id]: openaiProvider,
  [googleProvider.info.id]: googleProvider,
};

export const PROVIDER_LIST = Object.values(PROVIDERS);

export function getProvider(id: string): LLMProvider {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}

export * from './types';
