import { describe, it, expect } from 'vitest';
import { profileSchema } from '../schema';
import { fromPaste } from '../jd/normalize';
import { DEFAULT_CONSTRAINTS } from './prompt';
import { runTailor } from './run';
import { ingestResume } from '../parse/ingest';
import type { CompletionRequest, LLMProvider } from '../provider';

/**
 * How much room the two long calls ask for.
 *
 * Both used to pass 16,000 tokens explicitly. A plan for a full profile is
 * about 7,000 tokens of JSON and thinking shares the cap, so roughly one call
 * in four was cut off mid-string. The right ceiling depends on the provider
 * and model — Claude streams up to far more, other providers' limits are
 * their own — so the call leaves it to the provider.
 */
function recording(json: unknown): { provider: LLMProvider; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const provider = {
    info: { id: 'fake', label: 'Fake' },
    complete: async (req: CompletionRequest) => {
      requests.push(req);
      return { json, text: JSON.stringify(json), model: 'fake', usage: { inputTokens: 0, outputTokens: 0 } };
    },
  } as unknown as LLMProvider;
  return { provider, requests };
}

describe('the output cap on long calls', () => {
  it('lets the provider choose it for tailoring', async () => {
    const profile = profileSchema.parse({ id: 'p', createdAt: 'n', updatedAt: 'n', basics: { name: 'Dana Reyes' } });
    const { provider, requests } = recording({ summary: { text: '', rationale: '' } });
    await runTailor(profile, fromPaste('A posting.'), DEFAULT_CONSTRAINTS, provider, { apiKey: 'k', model: 'm' });
    expect(requests[0]!.maxTokens).toBeUndefined();
  });

  it('lets the provider choose it for ingest', async () => {
    const { provider, requests } = recording({ basics: { name: 'Dana Reyes' } });
    await ingestResume('resume text', provider, { apiKey: 'k', model: 'm' });
    expect(requests[0]!.maxTokens).toBeUndefined();
  });
});
