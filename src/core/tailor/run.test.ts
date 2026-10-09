import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileSchema } from '../schema';
import { fromPaste } from '../jd/normalize';
import { DEFAULT_CONSTRAINTS } from './prompt';
import { runTailor } from './run';
import { ingestResume } from '../parse/ingest';
import type { CompletionRequest, LLMProvider } from '../provider';
import { getTemplate } from '../render/templates';

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

describe('the summary, after the fit', () => {
  /**
   * The summary is written before the fit and the fit never looked at it
   * again, so a summary could go on citing a figure whose only bullet the fit
   * had just cut to make the page.
   */
  it('reports what it cites that the fitted page no longer shows', async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../evals/cases/platform-stretch');
    const profile = profileSchema.parse(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')));
    const plan = JSON.parse(readFileSync(join(dir, 'plans', '01.json'), 'utf8'));
    plan.summary.text =
      "Backend engineer with eight years on data-heavy services, most at home in Go and PostgreSQL, who cut a rating service's response time 4x. Experience owning event ingestion pipelines end to end, and mentoring engineers through on-call.";
    const { provider } = recording(plan);
    const outcome = await runTailor(
      profile,
      fromPaste(readFileSync(join(dir, 'posting.txt'), 'utf8')),
      DEFAULT_CONSTRAINTS,
      provider,
      { apiKey: 'k', model: 'm' },
      { template: getTemplate('roomy') },
    );
    // Roomy holds one bullet fewer than the plan includes, and the fit cuts
    // the one with the speed-up in it.
    expect(outcome.fit.dropped).toEqual(['blt_go_rewrite']);
    expect(outcome.summaryUnsupported).toEqual([{ term: '4x', restoredBy: ['bullet-drop:blt_go_rewrite'] }]);
  });
});
