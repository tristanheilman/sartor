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
