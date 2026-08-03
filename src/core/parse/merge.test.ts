import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import {
  DUPLICATE_THRESHOLD,
  applyMerge,
  bulletSimilarity,
  normalizeName,
  planMerge,
  summarizeMerge,
  type MergeAction,
} from './merge';

/**
 * Merging a source into the master profile.
 *
 * The profile is the document of record for every tailoring run, so the tests
 * that matter most here are the ones about what merging must *never* do:
 * overwrite canonical text, reuse an incoming ID, or quietly duplicate a fact.
 */

const NOW = '2025-06-01T00:00:00.000Z';

const LEDGER =
  'Led the migration of the settlement ledger to a sharded design, cutting p99 write latency from 840ms to 95ms.';
const IDEMPOTENCY = 'Designed an idempotency layer that eliminated duplicate captures.';

function baseProfile(): Profile {
  return profileSchema.parse({
    id: 'prf_base',
    label: 'Master',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    basics: {
      name: 'Jordan Avery',
      email: 'jordan.avery@example.com',
      location: { city: 'Austin', region: 'TX' },
    },
    work: [
      {
        id: 'wrk_northwind',
        name: 'Northwind Payments',
        position: 'Staff Software Engineer',
        startDate: '2021-03',
        endDate: '',
        bullets: [
          { id: 'blt_ledger', text: LEDGER },
          { id: 'blt_idem', text: IDEMPOTENCY },
        ],
      },
    ],
    skills: [{ id: 'skl_lang', name: 'Languages', keywords: ['Go', 'TypeScript'] }],
  });
}

/** An incoming profile. IDs here are deliberately junk — they must not survive. */
function incoming(overrides: Record<string, unknown>): Profile {
  return profileSchema.parse({
    id: 'prf_incoming',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

const work = (o: Record<string, unknown>) => ({
  id: 'wrk_incoming',
  name: 'Northwind Payments',
  position: 'Staff Software Engineer',
  startDate: '2021-03',
  endDate: '',
  bullets: [],
  ...o,
});

/** The whole merge, with every suggestion accepted. */
const merged = (base: Profile, next: Profile, decisions?: Record<string, MergeAction>) =>
  applyMerge(base, planMerge(base, next), { decisions, now: NOW, sourceLabel: 'resume-2024.pdf' });

describe('merging a profile into itself', () => {
  it('changes nothing but the timestamp', () => {
    const base = baseProfile();
    const result = merged(base, base);

    // The strongest single check in this file: if any part of matching,
    // deduplication or ID handling is wrong, this is where it shows.
    expect({ ...result, updatedAt: base.updatedAt }).toEqual(base);
    expect(result.updatedAt).toBe(NOW);
  });

  it('recognises every bullet as one it already has', () => {
    const base = baseProfile();
    const plan = planMerge(base, base);

    expect(plan.work[0]?.suggested).toBe('merge');
    expect(plan.work[0]?.bullets.map((b) => b.suggested)).toEqual(['skip', 'skip']);
    expect(plan.basics).toEqual([]);
  });
});

describe('comparing text', () => {
  it('ignores case and punctuation', () => {
    expect(bulletSimilarity('Shipped the billing API.', 'shipped the billing api')).toBe(1);
  });

  it('scores a rewording of the same fact as a near-duplicate', () => {
    const score = bulletSimilarity(
      IDEMPOTENCY,
      'Built an idempotency layer that removed duplicate captures.',
    );
    expect(score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('treats an elaboration of a bullet as the same fact', () => {
    // The case Jaccard alone gets wrong: a later resume adds the metric.
    expect(
      bulletSimilarity(
        'Built a FHIR ingestion pipeline.',
        'Built a FHIR ingestion pipeline handling 40 million records per day.',
      ),
    ).toBe(1);
  });

  it('does not confuse different work in the same area with an elaboration', () => {
    // Shares FHIR, million and records with the pair above, and must still be
    // filed as its own fact. This is the pair no single threshold separates.
    expect(
      bulletSimilarity(
        'Built a FHIR ingestion pipeline handling 40 million records per day.',
        'Built a FHIR export service handling 3 million records per hour.',
      ),
    ).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it('scores two unrelated bullets low', () => {
    expect(bulletSimilarity(LEDGER, 'Mentored four engineers, two of whom were promoted.')).toBeLessThan(
      DUPLICATE_THRESHOLD,
    );
  });

  it('will not call two short bullets duplicates on token overlap alone', () => {
    // Three tokens, two shared. Jaccard would say 0.5 and, with a lower
    // threshold, call these the same fact. They are not.
    expect(bulletSimilarity('Shipped the dashboard', 'Shipped the API')).toBe(0);
  });

  it('treats a legal suffix as noise in a company name', () => {
    expect(normalizeName('Northwind Payments, Inc.')).toBe(normalizeName('Northwind Payments'));
    expect(normalizeName('Cobalt Health LLC')).toBe('cobalt health');
  });
});

describe('matching entries', () => {
  it('merges a role at the same employer over overlapping dates', () => {
    const base = baseProfile();
    const plan = planMerge(base, incoming({ work: [work({ startDate: '2021-06', endDate: '2023-01' })] }));

    expect(plan.work[0]?.suggested).toBe('merge');
    expect(plan.work[0]?.match?.id).toBe('wrk_northwind');
  });

  it('adds a separate stint at the same employer, and says why', () => {
    const base = baseProfile();
    const plan = planMerge(
      base,
      incoming({ work: [work({ startDate: '2015-01', endDate: '2017-06' })] }),
    );

    expect(plan.work[0]?.suggested).toBe('add');
    expect(plan.work[0]?.match?.reason).toMatch(/separate stint/);
  });

  it('adds a role at an employer it has never seen', () => {
    const base = baseProfile();
    const plan = planMerge(base, incoming({ work: [work({ name: 'Cobalt Health' })] }));

    expect(plan.work[0]?.suggested).toBe('add');
    expect(plan.work[0]?.match).toBeNull();
  });

  it('matches a project by URL even when it has been renamed', () => {
    const base = profileSchema.parse({
      ...baseProfile(),
      projects: [{ id: 'prj_a', name: 'Old Name', url: 'https://github.com/jordan/thing' }],
    });
    const plan = planMerge(
      base,
      incoming({ projects: [{ id: 'prj_x', name: 'New Name', url: 'github.com/jordan/thing/' }] }),
    );

    expect(plan.projects[0]?.suggested).toBe('merge');
    expect(plan.projects[0]?.match?.reason).toBe('Same URL');
  });

  it('keeps two degrees from one university apart', () => {
    const base = profileSchema.parse({
      ...baseProfile(),
      education: [{ id: 'edu_bs', institution: 'University of Illinois', area: 'Computer Science' }],
    });
    const plan = planMerge(
      base,
      incoming({ education: [{ id: 'edu_x', institution: 'University of Illinois', area: 'Mathematics' }] }),
    );

    expect(plan.education[0]?.suggested).toBe('add');
  });
});

describe('bullets on a matched entry', () => {
  it('adds one it has never seen', () => {
    const base = baseProfile();
    const result = merged(
      base,
      incoming({ work: [work({ bullets: [{ id: 'blt_x', text: 'Mentored four engineers.' }] })] }),
    );

    expect(result.work).toHaveLength(1);
    expect(result.work[0]?.bullets.map((b) => b.text)).toEqual([
      LEDGER,
      IDEMPOTENCY,
      'Mentored four engineers.',
    ]);
  });

  it('files a rewording as a variant and leaves the canonical text alone', () => {
    const base = baseProfile();
    const reworded = 'Built an idempotency layer that removed duplicate captures.';
    const result = merged(
      base,
      incoming({ work: [work({ bullets: [{ id: 'blt_x', text: reworded }] })] }),
    );

    const bullet = result.work[0]?.bullets.find((b) => b.id === 'blt_idem');
    expect(result.work[0]?.bullets).toHaveLength(2); // no new line
    expect(bullet?.text).toBe(IDEMPOTENCY); // canonical untouched
    expect(bullet?.variants).toHaveLength(1);
    expect(bullet?.variants[0]).toMatchObject({
      text: reworded,
      source: 'original',
      note: 'resume-2024.pdf',
    });
  });

  it('drops a word-for-word repeat rather than storing it twice', () => {
    const base = baseProfile();
    const result = merged(
      base,
      incoming({ work: [work({ bullets: [{ id: 'blt_x', text: IDEMPOTENCY }] })] }),
    );

    const bullet = result.work[0]?.bullets.find((b) => b.id === 'blt_idem');
    expect(bullet?.variants).toEqual([]);
  });
});

describe('applying decisions', () => {
  it('mints new IDs and never reuses an incoming one', () => {
    const base = baseProfile();
    const result = merged(
      base,
      incoming({ work: [work({ name: 'Cobalt Health', bullets: [{ id: 'blt_x', text: 'Built a pipeline.' }] })] }),
    );

    const added = result.work[1];
    expect(added?.id).not.toBe('wrk_incoming');
    expect(added?.id).toMatch(/^wrk_/);
    expect(added?.bullets[0]?.id).not.toBe('blt_x');
    expect(added?.bullets[0]?.id).toMatch(/^blt_/);
  });

  it('leaves the profile untouched when everything is skipped', () => {
    const base = baseProfile();
    const next = incoming({ work: [work({ name: 'Cobalt Health' })] });
    const plan = planMerge(base, next);

    const decisions = Object.fromEntries(plan.work.map((c) => [c.key, 'skip' as const]));
    const result = applyMerge(base, plan, { decisions, now: NOW });

    expect({ ...result, updatedAt: base.updatedAt }).toEqual(base);
  });

  it('honours the user overriding a suggestion', () => {
    const base = baseProfile();
    const next = incoming({ work: [work({ bullets: [{ id: 'blt_x', text: IDEMPOTENCY }] })] });
    const plan = planMerge(base, next);
    const bulletKey = plan.work[0]?.bullets[0]?.key ?? '';

    expect(plan.work[0]?.bullets[0]?.suggested).toBe('skip');

    const result = applyMerge(base, plan, { decisions: { [bulletKey]: 'add' }, now: NOW });
    expect(result.work[0]?.bullets).toHaveLength(3);
  });

  it('still refuses to store a variant identical to text it already has', () => {
    // The user can override the suggestion; "append-only" must not become
    // "accumulates duplicates" when they do.
    const base = baseProfile();
    const next = incoming({ work: [work({ bullets: [{ id: 'blt_x', text: IDEMPOTENCY }] })] });
    const plan = planMerge(base, next);
    const bulletKey = plan.work[0]?.bullets[0]?.key ?? '';

    const result = applyMerge(base, plan, { decisions: { [bulletKey]: 'merge' }, now: NOW });

    const bullet = result.work[0]?.bullets.find((b) => b.id === 'blt_idem');
    expect(bullet?.variants).toEqual([]);
    expect(result.work[0]?.bullets).toHaveLength(2);
  });

  it('unions skill keywords without duplicating or recasing them', () => {
    const base = baseProfile();
    const result = merged(
      base,
      incoming({ skills: [{ id: 'skl_x', name: 'Languages', keywords: ['typescript', 'Python'] }] }),
    );

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.keywords).toEqual(['Go', 'TypeScript', 'Python']);
  });
});

describe('closing out a role you have left', () => {
  const left = (endDate: string) =>
    incoming({ work: [work({ endDate })] });

  it('offers to close a role the profile still shows as current', () => {
    const base = baseProfile(); // Northwind: 2021-03 – (open)
    const plan = planMerge(base, left('2025-11'));
    const field = plan.work[0]?.fields[0];

    expect(field).toMatchObject({ current: '(blank)', incoming: '2025-11', suggested: 'add' });
    expect(field?.reason).toMatch(/two concurrent jobs/);
  });

  it('applies the close-out so the resume cannot show two current jobs', () => {
    const base = baseProfile();
    const result = merged(base, left('2025-11'));

    expect(result.work[0]?.endDate).toBe('2025-11');
    expect(result.work[0]?.startDate).toBe('2021-03'); // untouched
  });

  it('keeps the existing date when two specific dates disagree', () => {
    const base = profileSchema.parse({
      ...baseProfile(),
      work: [{ ...baseProfile().work[0], endDate: '2025-06' }],
    });
    const plan = planMerge(base, left('2025-11'));

    expect(plan.work[0]?.fields[0]?.suggested).toBe('skip');
    expect(applyMerge(base, plan, { now: NOW }).work[0]?.endDate).toBe('2025-06');
  });

  it('lets the user take the incoming date on a real conflict', () => {
    const base = profileSchema.parse({
      ...baseProfile(),
      work: [{ ...baseProfile().work[0], endDate: '2025-06' }],
    });
    const plan = planMerge(base, left('2025-11'));
    const key = plan.work[0]?.fields[0]?.key ?? '';

    expect(applyMerge(base, plan, { decisions: { [key]: 'add' }, now: NOW }).work[0]?.endDate).toBe('2025-11');
  });

  it('never blanks a date it already has', () => {
    const base = baseProfile();
    const result = merged(base, incoming({ work: [work({ startDate: '', endDate: '' })] }));

    expect(result.work[0]?.startDate).toBe('2021-03');
  });

  it('matches the role even when the resume writes dates as MM/YYYY', () => {
    // The format a real resume used. A YYYY-MM-only parser saw no overlap,
    // dropped to a weak match, and added a second copy of the same employer.
    const base = profileSchema.parse({
      ...baseProfile(),
      work: [{ ...baseProfile().work[0], startDate: '05/2022', endDate: '' }],
    });
    const plan = planMerge(base, incoming({ work: [work({ startDate: '05/2022', endDate: '11/2025' })] }));

    expect(plan.work[0]?.suggested).toBe('merge');
    const result = applyMerge(base, plan, { now: NOW });
    expect(result.work).toHaveLength(1);
    expect(result.work[0]?.endDate).toBe('11/2025');
  });

  it('counts corrections in the summary', () => {
    const base = baseProfile();
    const plan = planMerge(base, left('2025-11'));
    expect(summarizeMerge(plan).datesCorrected).toBe(1);
  });
});

describe('basics', () => {
  it('fills a blank field', () => {
    const base = baseProfile();
    const plan = planMerge(base, incoming({ basics: { phone: '(555) 010-4477' } }));

    expect(plan.basics[0]).toMatchObject({ label: 'Phone', current: '', suggested: 'add' });
    expect(applyMerge(base, plan, { now: NOW }).basics.phone).toBe('(555) 010-4477');
  });

  it('keeps the existing value when the two disagree', () => {
    const base = baseProfile();
    const plan = planMerge(base, incoming({ basics: { email: 'stale@example.com' } }));

    expect(plan.basics[0]).toMatchObject({
      label: 'Email',
      current: 'jordan.avery@example.com',
      incoming: 'stale@example.com',
      suggested: 'skip',
    });
    expect(applyMerge(base, plan, { now: NOW }).basics.email).toBe('jordan.avery@example.com');
  });

  it('lets the user take the incoming value instead', () => {
    const base = baseProfile();
    const plan = planMerge(base, incoming({ basics: { email: 'new@example.com' } }));

    const result = applyMerge(base, plan, { decisions: { 'basics.email': 'add' }, now: NOW });
    expect(result.basics.email).toBe('new@example.com');
  });
});

describe('summarizeMerge', () => {
  it('counts what the confirmation screen needs to show', () => {
    const base = baseProfile();
    const plan = planMerge(
      base,
      incoming({
        work: [
          work({
            bullets: [
              { id: 'b1', text: 'Mentored four engineers.' },
              { id: 'b2', text: 'Built an idempotency layer that removed duplicate captures.' },
              { id: 'b3', text: IDEMPOTENCY },
            ],
          }),
          work({ id: 'wrk_new', name: 'Cobalt Health', startDate: '2018-06', endDate: '2021-02' }),
        ],
        basics: { phone: '(555) 010-4477' },
      }),
    );

    expect(summarizeMerge(plan)).toEqual({
      newEntries: 1, // Cobalt Health
      mergedEntries: 1, // Northwind
      newBullets: 1, // "Mentored four engineers."
      newVariants: 1, // the rewording
      basicsChanged: 1, // phone
      datesCorrected: 0,
      skipped: 1, // the word-for-word repeat
    });
  });
});

describe('the same sentence twice', () => {
  // From a real run: one interview answer produced "Managed state in React
  // Native mobile and React web applications using Redux." under two different
  // employers, word for word, and both were added. Duplicate detection only
  // ever looked at the entry a bullet matched, so two entries never saw each
  // other.
  const REDUX = 'Managed state in React Native mobile and React web applications using Redux.';

  it('drops the copy when one answer lands the same sentence on two employers', () => {
    const base = baseProfile();
    const result = merged(
      base,
      incoming({
        work: [
          work({ bullets: [{ id: 'b1', text: REDUX }] }),
          work({ id: 'wrk_other', name: 'Cobalt Health', startDate: '2018-06', endDate: '2021-02', bullets: [{ id: 'b2', text: REDUX }] }),
        ],
      }),
    );

    const everywhere = result.work.flatMap((w) => w.bullets.map((b) => b.text));
    expect(everywhere.filter((t) => t === REDUX)).toHaveLength(1);
  });

  it('drops a sentence already sitting under a different entry', () => {
    const base = profileSchema.parse({
      ...baseProfile(),
      work: [
        { ...baseProfile().work[0] },
        { id: 'wrk_old', name: 'Cobalt Health', position: 'Engineer', startDate: '2018-06', endDate: '2021-02', bullets: [{ id: 'blt_redux', text: REDUX }] },
      ],
    });
    const result = merged(base, incoming({ work: [work({ bullets: [{ id: 'b1', text: REDUX }] })] }));

    expect(result.work.flatMap((w) => w.bullets).filter((b) => b.text === REDUX)).toHaveLength(1);
  });

  it('still allows the same work described differently at two jobs', () => {
    // Genuinely doing the same thing twice is normal. It is the identical
    // sentence that is always a mistake.
    const base = baseProfile();
    const result = merged(
      base,
      incoming({
        work: [
          work({ bullets: [{ id: 'b1', text: 'Managed Redux state across the driver app.' }] }),
          work({ id: 'wrk_other', name: 'Cobalt Health', startDate: '2018-06', endDate: '2021-02', bullets: [{ id: 'b2', text: 'Owned the Redux store for the clinician web client.' }] }),
        ],
      }),
    );

    expect(result.work.flatMap((w) => w.bullets).filter((b) => /Redux/.test(b.text))).toHaveLength(2);
  });
});
