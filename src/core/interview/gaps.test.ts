import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '../schema';
import { findGaps, remainingGaps } from './gaps';

/**
 * Which question to ask next.
 *
 * The ranking is the product. A tool that opens with "you list Figma as a
 * skill" when the person changed jobs nine months ago has wasted the only
 * attention it was going to get.
 */

const NOW = new Date('2026-08-02T00:00:00Z');

function profile(overrides: Record<string, unknown> = {}): Profile {
  return profileSchema.parse({
    id: 'prf_1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    basics: { name: 'Riley Okafor', summary: 'Backend engineer.' },
    work: [
      {
        id: 'wrk_1',
        name: 'Harbor Freight',
        position: 'Senior Engineer',
        startDate: '2021-02',
        endDate: '',
        bullets: [
          { id: 'blt_1', text: 'Resharded the ledger in PostgreSQL, cutting p99 to 120ms.' },
          { id: 'blt_2', text: 'Owned the Kafka ingestion pipeline for carrier events.' },
          { id: 'blt_3', text: 'Mentored five engineers through on-call.' },
        ],
      },
    ],
    skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Go', 'PostgreSQL', 'Kafka'] }],
    ...overrides,
  });
}

const find = (p: Profile, jdText = '') => findGaps(p, { now: NOW, jdText });

describe('work the profile does not know about', () => {
  it('asks about a newer job even when the profile looks current', () => {
    // The single case no data can reveal: the profile says "still there", so
    // nothing in it can show they left. Nine months at a new job is invisible
    // unless we ask.
    const gaps = find(profile());

    expect(gaps[0]?.kind).toBe('recent-work');
    expect(gaps[0]?.id).toBe('recent:since-current');
    expect(gaps[0]?.why).toContain('Harbor Freight');
  });

  it('leads with the gap when the last role actually ended', () => {
    const ended = profile({
      work: [{ ...profile().work[0], endDate: '2025-11' }],
    });
    const gaps = find(ended);

    expect(gaps[0]?.id).toBe('recent:gap');
    expect(gaps[0]?.subject).toContain('9 months');
    // Outranks everything. An unexplained gap is the most expensive omission.
    expect(gaps[0]?.weight).toBeGreaterThan(gaps[1]?.weight ?? 0);
  });

  it('stays quiet about a role that ended last month', () => {
    const recent = profile({ work: [{ ...profile().work[0], endDate: '2026-07' }] });
    expect(find(recent).some((g) => g.id === 'recent:gap')).toBe(false);
  });

  it('reads the date formats resumes actually use', () => {
    for (const endDate of ['2025-11', '11/2025']) {
      const p = profile({ work: [{ ...profile().work[0], endDate }] });
      expect(find(p)[0]?.subject, endDate).toContain('9 months');
    }
  });

  it('asks about work history when there is none at all', () => {
    const blank = profile({ work: [], skills: [] });
    expect(find(blank)[0]?.id).toBe('recent:none');
  });
});

describe('skills with nothing behind them', () => {
  it('asks about a keyword no bullet demonstrates', () => {
    const p = profile({
      skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Go', 'Rust'] }],
    });
    const gaps = find(p);

    // Go appears in no bullet either, but Rust is the point: both are claims
    // with no evidence, and both should surface.
    expect(gaps.filter((g) => g.kind === 'unbacked-skill').map((g) => g.subject)).toContain('Rust');
  });

  it('leaves a skill alone once a bullet evidences it', () => {
    const gaps = find(profile());
    const subjects = gaps.filter((g) => g.kind === 'unbacked-skill').map((g) => g.subject);

    // PostgreSQL and Kafka both appear in bullets.
    expect(subjects).not.toContain('PostgreSQL');
    expect(subjects).not.toContain('Kafka');
  });

  it('ranks a skill the posting demands above one it does not', () => {
    const p = profile({
      skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Rust', 'Matlab'] }],
    });
    const gaps = find(p, 'We need strong experience with Rust in production. Required.');

    const rust = gaps.find((g) => g.subject === 'Rust');
    const matlab = gaps.find((g) => g.subject === 'Matlab');
    expect(rust?.weight).toBeGreaterThan(matlab?.weight ?? 0);
  });
});

describe('ranking and budget', () => {
  it('never returns more questions than the limit', () => {
    const many = profile({
      skills: [
        { id: 'skl_1', name: 'A', keywords: Array.from({ length: 40 }, (_, i) => `Tool${i}`) },
      ],
    });
    expect(findGaps(many, { now: NOW, limit: 5 })).toHaveLength(5);
  });

  it('is ordered by weight, descending', () => {
    const weights = find(profile()).map((g) => g.weight);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it('is deterministic for the same input', () => {
    expect(find(profile())).toEqual(find(profile()));
  });
});

describe('dropping questions an answer already covered', () => {
  it('removes a skill question once the answer evidences the skill', () => {
    const p = profile({ skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Rust'] }] });
    const gaps = find(p);
    expect(gaps.some((g) => g.subject === 'Rust')).toBe(true);

    // This is what makes the remaining count fall faster than one per answer.
    const left = remainingGaps(gaps, ['I wrote the Rust service that handles rating.']);
    expect(left.some((g) => g.subject === 'Rust')).toBe(false);
  });

  it('keeps questions the answer said nothing about', () => {
    const gaps = find(profile());
    expect(remainingGaps(gaps, ['Not really, no.'])).toEqual(gaps);
  });
});

describe('the limit counts questions worth asking', () => {
  /**
   * A profile with far more unbacked skills than the cap, so the ranking has
   * to choose — which is when excluding the answered ones starts to matter.
   */
  const many = (n: number) =>
    profileSchema.parse({
      id: 'prf_many',
      createdAt: 'now',
      updatedAt: 'now',
      basics: { name: 'Priya Raman', summary: 'Mobile developer.' },
      work: [
        {
          id: 'wrk_1',
          name: 'Halcyon Fleet',
          position: 'Lead Mobile Developer',
          startDate: '05/2022',
          endDate: '',
          bullets: [
            { id: 'b1', text: 'Owned the release process end to end.' },
            { id: 'b2', text: 'Rebuilt the sync layer.' },
            { id: 'b3', text: 'Cut cold start time.' },
          ],
        },
      ],
      skills: [
        {
          id: 'skl_1',
          name: 'Tools',
          keywords: Array.from({ length: n }, (_, i) => `Tool${String(i).padStart(2, '0')}`),
        },
      ],
    });

  it('still caps how many are returned', () => {
    expect(findGaps(many(40), { limit: 12 }).length).toBe(12);
  });

  it('pulls in the next-ranked gap when one is excluded', () => {
    // The defect: the panel filtered its skipped list *after* the cap, so
    // skipping a question shrank the queue instead of revealing the one
    // behind it. Skip eight and only four remain — the thirteenth-ranked
    // skill can never be asked about, however long the session runs.
    const all = findGaps(many(40), { limit: 12 });
    const skip = all.slice(0, 8).map((g) => g.id);

    const after = findGaps(many(40), { limit: 12, exclude: skip });

    expect(after.length).toBe(12);
    expect(after.some((g) => skip.includes(g.id))).toBe(false);
  });

  it('reveals a gap that was ranked below the cap', () => {
    const all = findGaps(many(40), { limit: 12 });
    const beyond = findGaps(many(40), { limit: 40 })[12];
    expect(beyond).toBeDefined();
    expect(all.some((g) => g.id === beyond!.id)).toBe(false);

    const after = findGaps(many(40), { limit: 12, exclude: all.map((g) => g.id) });
    expect(after.some((g) => g.id === beyond!.id)).toBe(true);
  });

  it('accepts a Set as well as an array', () => {
    const all = findGaps(many(40), { limit: 12 });
    const excluded = findGaps(many(40), { limit: 12, exclude: new Set([all[0]!.id]) });
    expect(excluded.some((g) => g.id === all[0]!.id)).toBe(false);
  });

  it('runs out only when every gap really is answered', () => {
    const everything = findGaps(many(40), { limit: 200 });
    expect(findGaps(many(40), { limit: 12, exclude: everything.map((g) => g.id) })).toEqual([]);
  });
});
