import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import { tailorPlanSchema, type TailorPlan } from './plan';
import { buildChanges, buildDocument, type Change } from './apply';
import { unsupportedSummaryTerms } from './support';
import { buildCoverage } from './coverage';
import { documentToSlices } from '../render/model';

/**
 * The summary is written with the whole profile in view; the fit pass decides
 * afterwards what the page has room for. A summary citing a number or a
 * technology whose only bullet the fit then cut still says it, with nothing
 * left on the page to show it.
 */

const profile: Profile = profileSchema.parse({
  id: 'prf_1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  basics: { name: 'Dana Reyes', summary: 'Backend engineer.', email: 'dana@example.com' },
  work: [
    {
      id: 'wrk_1',
      name: 'Acme Robotics',
      position: 'Senior Engineer',
      startDate: '2016-03',
      endDate: '2024-11',
      bullets: [
        { id: 'blt_1', text: 'Moved order events onto Kafka, cutting checkout latency 40%.', tags: [], variants: [] },
        { id: 'blt_2', text: 'Ran the billing service on PostgreSQL.', tags: [], variants: [] },
        { id: 'blt_3', text: 'Mentored three engineers.', tags: [], variants: [] },
      ],
    },
    {
      id: 'wrk_2',
      name: 'Tidewater',
      position: 'Engineer',
      startDate: '2014-01',
      endDate: '2016-02',
      bullets: [{ id: 'blt_4', text: 'Built the reporting pipeline on Airflow.', tags: [], variants: [] }],
    },
  ],
  skills: [{ id: 'skl_1', name: 'Tools', keywords: ['Terraform', 'Redis', 'Datadog'] }],
});

/** Every bullet in, except those listed; skills as given. */
function plan(summary: string, opts: { without?: string[]; keywords?: string[]; dropRole?: string } = {}): TailorPlan {
  const without = new Set(opts.without ?? []);
  return tailorPlanSchema.parse({
    summary: { text: summary, rationale: '' },
    work: profile.work.map((w, i) => ({
      id: w.id,
      include: w.id !== opts.dropRole,
      order: i,
      bullets: w.bullets.map((b, j) => ({ bulletId: b.id, include: !without.has(b.id), order: j, text: '', textSource: 'canonical', rationale: '' })),
    })),
    skills: [{ id: 'skl_1', include: true, order: 0, keywords: opts.keywords ?? ['Terraform', 'Redis', 'Datadog'] }],
  });
}

function check(p: TailorPlan, edit?: (changes: Change[]) => void, source: Profile = profile) {
  const changes = buildChanges(source, p);
  edit?.(changes);
  return unsupportedSummaryTerms(source, p, changes);
}

describe('a summary checked against the page it ends up on', () => {
  const summary = 'Backend engineer who moved order events onto Kafka and cut checkout latency 40%.';

  it('reports nothing when the page still shows what the summary says', () => {
    expect(check(plan(summary))).toEqual([]);
  });

  it('reports a technology and a number whose only bullet was cut, and the change that cut it', () => {
    expect(check(plan(summary, { without: ['blt_1'] }))).toEqual([
      { term: 'Kafka', restoredBy: ['bullet-drop:blt_1'] },
      { term: '40%', restoredBy: ['bullet-drop:blt_1'] },
    ]);
  });

  it('stops reporting it once that change is rejected', () => {
    const p = plan(summary, { without: ['blt_1'] });
    const terms = check(p, (changes) => {
      changes.find((c) => c.id === 'bullet-drop:blt_1')!.status = 'rejected';
    });
    expect(terms).toEqual([]);
  });

  it('points at a dropped role', () => {
    expect(check(plan('Started out building reporting on Airflow.', { dropRole: 'wrk_2' }))).toEqual([
      { term: 'Airflow', restoredBy: ['entry-drop:wrk_2'] },
    ]);
  });

  it('counts the skills line as the page showing it, and points at the keywords cut from it', () => {
    expect(check(plan('Runs infrastructure with Terraform.'))).toEqual([]);
    expect(check(plan('Runs infrastructure with Terraform.', { keywords: ['Redis', 'Datadog'] }))).toEqual([
      { term: 'Terraform', restoredBy: ['skills:skl_1'] },
    ]);
  });

  it('leaves a term the profile does not have to the guard', () => {
    // Kubernetes is a fabrication, which blocks export already; it is not a
    // question of what the page shows.
    expect(check(plan('Backend engineer who runs Kubernetes.'))).toEqual([]);
  });

  it('takes years of experience as shown by the dates', () => {
    // The profile's own summary says it, so it is not a fabrication; no
    // bullet does, but "8 years" is what the dates on the page say. And 2016
    // is a start date there.
    const own = { ...profile, basics: { ...profile.basics, summary: 'Backend engineer with 8 years of experience.' } };
    const terms = check(plan('Backend engineer with 8 years on data services, since 2016.'), undefined, own);
    expect(terms).toEqual([]);
  });

  it('still reports a number that is not a span of years', () => {
    const own = { ...profile, basics: { ...profile.basics, summary: 'Backend engineer who led 8 launches.' } };
    expect(check(plan('Backend engineer who led 8 launches.'), undefined, own)).toEqual([{ term: '8', restoredBy: [] }]);
  });

  it('does not ask the page to show a kind of thing', () => {
    // "APIs" says what sort of work it was; there is no evidence of it to cut.
    const own = { ...profile, basics: { ...profile.basics, summary: 'Backend engineer who designs APIs and SDKs.' } };
    expect(check(plan('Backend engineer who designs APIs and SDKs.'), undefined, own)).toEqual([]);
  });

  it('reports nothing when there is no summary', () => {
    expect(check(plan('', { without: ['blt_1'] }))).toEqual([]);
  });
});

describe('coverage, on the same page', () => {
  // Two reports on one page must not disagree: coverage called a term the
  // summary alone named "in your resume" while this check said nothing on the
  // page showed it.
  const posting = 'Backend Engineer\n\nExperience with Kafka and PostgreSQL is required. You have designed APIs.\n';
  const summary = 'Backend engineer who moved order events onto Kafka and designs APIs.';

  const both = (p: TailorPlan) => {
    const changes = buildChanges(profile, p);
    const coverage = buildCoverage(posting, documentToSlices(buildDocument(profile, p, changes)), profile);
    return { coverage, unsupported: unsupportedSummaryTerms(profile, p, changes).map((t) => t.term) };
  };

  it('agrees that a term only the summary names is not shown', () => {
    const { coverage, unsupported } = both(plan(summary, { without: ['blt_1'] }));
    expect(unsupported).toContain('Kafka');
    expect(coverage.terms.find((t) => t.norm === 'kafka')!.status).not.toBe('present');
  });

  it('agrees that it is shown once a bullet says it', () => {
    const { coverage, unsupported } = both(plan(summary));
    expect(unsupported).not.toContain('Kafka');
    expect(coverage.terms.find((t) => t.norm === 'kafka')!.status).toBe('present');
  });

  it('agrees that a kind of thing is neither a requirement nor a claim to back', () => {
    const { coverage, unsupported } = both(plan(summary, { without: ['blt_1'] }));
    expect(unsupported).not.toContain('APIs');
    expect(coverage.terms.map((t) => t.norm)).not.toContain('apis');
  });
});

