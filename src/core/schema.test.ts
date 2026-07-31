import { describe, it, expect } from 'vitest';
import {
  profileSchema,
  safeParseProfile,
  emptyProfile,
  allBullets,
  findBullet,
  SECTION_KEYS,
} from './schema';
import { tailorPlanSchema, TAILOR_PLAN_JSON_SCHEMA } from './tailor/plan';
import { validatePlan } from './tailor/run';

describe('profileSchema', () => {
  it('fills in every optional section so downstream code never sees undefined', () => {
    const p = profileSchema.parse({
      id: 'prf_1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    expect(p.work).toEqual([]);
    expect(p.skills).toEqual([]);
    expect(p.basics.name).toBe('');
    expect(p.schemaVersion).toBe(1);
  });

  it('requires an id', () => {
    expect(safeParseProfile({ createdAt: 'x', updatedAt: 'x' }).success).toBe(false);
  });

  it('rejects a bullet with no id, because provenance is not optional', () => {
    const result = safeParseProfile({
      id: 'prf_1',
      createdAt: 'x',
      updatedAt: 'x',
      work: [{ id: 'wrk_1', bullets: [{ text: 'Did a thing' }] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty bullet, which would render as a blank line', () => {
    const result = safeParseProfile({
      id: 'prf_1',
      createdAt: 'x',
      updatedAt: 'x',
      work: [{ id: 'wrk_1', bullets: [{ id: 'blt_1', text: '   ' }] }],
    });
    expect(result.success).toBe(false);
  });

  it('defaults variants to an empty array so write-back can always append', () => {
    const p = profileSchema.parse({
      id: 'prf_1',
      createdAt: 'x',
      updatedAt: 'x',
      work: [{ id: 'wrk_1', bullets: [{ id: 'blt_1', text: 'Shipped it' }] }],
    });
    expect(p.work[0]!.bullets[0]!.variants).toEqual([]);
    expect(p.work[0]!.bullets[0]!.tags).toEqual([]);
  });

  it('accepts free-text dates, because real resumes are not consistent', () => {
    const p = profileSchema.parse({
      id: 'prf_1',
      createdAt: 'x',
      updatedAt: 'x',
      work: [{ id: 'wrk_1', startDate: 'Summer 2019', endDate: 'Present' }],
    });
    expect(p.work[0]!.startDate).toBe('Summer 2019');
  });

  it('round-trips through JSON without loss', () => {
    const p = profileSchema.parse({
      id: 'prf_1',
      createdAt: 'x',
      updatedAt: 'x',
      work: [
        {
          id: 'wrk_1',
          name: 'Acme',
          bullets: [
            {
              id: 'blt_1',
              text: 'Shipped it',
              tags: ['infra'],
              variants: [{ id: 'var_1', text: 'Delivered it', source: 'llm', createdAt: 'x' }],
            },
          ],
        },
      ],
    });
    expect(profileSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
  });

  it('emptyProfile produces a valid profile', () => {
    expect(safeParseProfile(emptyProfile('prf_x')).success).toBe(true);
  });
});

describe('bullet helpers', () => {
  const p = profileSchema.parse({
    id: 'prf_1',
    createdAt: 'x',
    updatedAt: 'x',
    work: [{ id: 'wrk_1', name: 'Acme', position: 'Eng', bullets: [{ id: 'blt_1', text: 'A' }] }],
    projects: [{ id: 'prj_1', name: 'Thing', bullets: [{ id: 'blt_2', text: 'B' }] }],
    education: [{ id: 'edu_1', institution: 'Uni', bullets: [{ id: 'blt_3', text: 'C' }] }],
  });

  it('collects bullets from every section that has them', () => {
    expect(allBullets(p).map((b) => b.bullet.id)).toEqual(['blt_1', 'blt_2', 'blt_3']);
  });

  it('labels each bullet with its owner and section', () => {
    const found = allBullets(p).find((b) => b.bullet.id === 'blt_2')!;
    expect(found.section).toBe('projects');
    expect(found.ownerLabel).toBe('Thing');
  });

  it('finds a bullet by id, and returns undefined for an unknown one', () => {
    expect(findBullet(p, 'blt_3')?.text).toBe('C');
    expect(findBullet(p, 'nope')).toBeUndefined();
  });
});

describe('tailorPlanSchema', () => {
  it('defaults to the canonical section order', () => {
    const plan = tailorPlanSchema.parse({ summary: {} });
    expect(plan.sectionOrder).toEqual([...SECTION_KEYS]);
    expect(plan.work).toEqual([]);
  });

  it('rejects a section key it does not know', () => {
    const r = tailorPlanSchema.safeParse({ summary: {}, sectionOrder: ['hobbies'] });
    expect(r.success).toBe(false);
  });

  it('exposes a strict JSON Schema, as every provider requires', () => {
    expect(TAILOR_PLAN_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(TAILOR_PLAN_JSON_SCHEMA.required).toContain('work');
    expect(TAILOR_PLAN_JSON_SCHEMA.$defs.entries.items.additionalProperties).toBe(false);
  });
});

describe('validatePlan', () => {
  const profile = profileSchema.parse({
    id: 'prf_1',
    createdAt: 'x',
    updatedAt: 'x',
    work: [{ id: 'wrk_1', name: 'Acme', bullets: [{ id: 'blt_1', text: 'Real bullet' }] }],
    skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Go'] }],
  });

  it('keeps everything that points at a real profile element', () => {
    const plan = tailorPlanSchema.parse({
      summary: {},
      work: [{ id: 'wrk_1', include: true, order: 0, bullets: [{ bulletId: 'blt_1', include: true, order: 0 }] }],
      skills: [{ id: 'skl_1', include: true, order: 0, keywords: ['Go'] }],
    });
    const { plan: out, dropped } = validatePlan(plan, profile);
    expect(dropped).toEqual([]);
    expect(out.work[0]!.bullets).toHaveLength(1);
  });

  it('discards a hallucinated employer entirely', () => {
    const plan = tailorPlanSchema.parse({
      summary: {},
      work: [
        { id: 'wrk_1', include: true, order: 0, bullets: [] },
        { id: 'wrk_ghost', include: true, order: 1, bullets: [] },
      ],
    });
    const { plan: out, dropped } = validatePlan(plan, profile);
    expect(out.work.map((w) => w.id)).toEqual(['wrk_1']);
    expect(dropped.join(' ')).toContain('wrk_ghost');
  });

  it('discards a bullet that belongs to no real entry', () => {
    const plan = tailorPlanSchema.parse({
      summary: {},
      work: [
        {
          id: 'wrk_1',
          include: true,
          order: 0,
          bullets: [
            { bulletId: 'blt_1', include: true, order: 0 },
            { bulletId: 'blt_ghost', include: true, order: 1, text: 'Invented achievement' },
          ],
        },
      ],
    });
    const { plan: out, dropped } = validatePlan(plan, profile);
    expect(out.work[0]!.bullets.map((b) => b.bulletId)).toEqual(['blt_1']);
    expect(dropped.join(' ')).toContain('blt_ghost');
  });

  it('discards an unknown skill group', () => {
    const plan = tailorPlanSchema.parse({
      summary: {},
      skills: [{ id: 'skl_ghost', include: true, order: 0, keywords: ['Rust'] }],
    });
    expect(validatePlan(plan, profile).plan.skills).toEqual([]);
  });
});
