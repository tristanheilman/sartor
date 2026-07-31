import { describe, it, expect } from 'vitest';
import { profileSchema, type Profile } from '@/core/schema';
import { tailorPlanSchema, type TailorPlan } from './plan';
import { buildChanges, buildDocument, writeBackVariants, blockingChanges, type TailorRun } from './apply';
import { documentToText } from '@/core/render/model';

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
      startDate: '2021-03',
      endDate: '2024-11',
      bullets: [
        { id: 'blt_1', text: 'Led the billing migration to PostgreSQL.', tags: [], variants: [] },
        { id: 'blt_2', text: 'Mentored three engineers.', tags: [], variants: [] },
      ],
    },
    {
      id: 'wrk_2',
      name: '初 Labs',
      position: 'Engineer',
      startDate: '2019-01',
      endDate: '2021-02',
      bullets: [{ id: 'blt_3', text: 'Maintained the payments service.', tags: [], variants: [] }],
    },
  ],
  skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Go', 'Python', 'Ruby'] }],
});

const plan: TailorPlan = tailorPlanSchema.parse({
  summary: { text: 'Backend engineer focused on billing systems.', rationale: 'Matches the posting.' },
  sectionOrder: ['summary', 'skills', 'work', 'projects', 'education', 'certificates', 'awards'],
  work: [
    {
      id: 'wrk_1',
      include: true,
      order: 0,
      bullets: [
        {
          bulletId: 'blt_1',
          include: true,
          order: 0,
          text: 'Migrated billing to PostgreSQL.',
          textSource: 'new',
          rationale: 'Tightened for relevance.',
        },
        { bulletId: 'blt_2', include: false, order: 1, text: '', textSource: 'canonical', rationale: 'Less relevant.' },
      ],
    },
    { id: 'wrk_2', include: false, order: 1, bullets: [] },
  ],
  projects: [],
  education: [],
  skills: [{ id: 'skl_1', include: true, order: 0, keywords: ['Go', 'Python'] }],
  notes: 'The posting asks for Kubernetes; the profile does not mention it.',
});

describe('buildChanges', () => {
  const changes = buildChanges(profile, plan);

  it('produces one change per decision, with stable ids', () => {
    const ids = changes.map((c) => c.id).sort();
    expect(ids).toEqual(
      [
        'summary:basics',
        'bullet-text:blt_1',
        'bullet-drop:blt_2',
        'entry-drop:wrk_2',
        'skills:skl_1',
      ].sort(),
    );
  });

  it('regenerates identical ids for the same plan, so review survives reload', () => {
    expect(buildChanges(profile, plan).map((c) => c.id)).toEqual(changes.map((c) => c.id));
  });

  it('defaults to accepted-but-unreviewed', () => {
    expect(changes.every((c) => c.status === 'accepted' && !c.reviewed)).toBe(true);
  });

  it('carries the before text from the master profile', () => {
    const c = changes.find((x) => x.id === 'bullet-text:blt_1')!;
    expect(c.before).toBe('Led the billing migration to PostgreSQL.');
    expect(c.after).toBe('Migrated billing to PostgreSQL.');
  });

  it('does not flag a faithful rephrasing', () => {
    expect(changes.find((x) => x.id === 'bullet-text:blt_1')!.violations).toEqual([]);
  });

  it('flags a rephrasing that introduces an ungrounded technology', () => {
    const bad = structuredClone(plan);
    bad.work[0]!.bullets[0]!.text = 'Migrated billing to PostgreSQL on Kubernetes.';
    const c = buildChanges(profile, bad).find((x) => x.id === 'bullet-text:blt_1')!;
    expect(c.violations.map((v) => v.token)).toEqual(['Kubernetes']);
  });

  it('scopes violations to the change that produced them', () => {
    const bad = structuredClone(plan);
    bad.work[0]!.bullets[0]!.text = 'Migrated billing on Kubernetes.';
    bad.summary.text = 'Engineer using Kubernetes.';
    const cs = buildChanges(profile, bad);
    const bulletV = cs.find((c) => c.id === 'bullet-text:blt_1')!.violations;
    const summaryV = cs.find((c) => c.id === 'summary:basics')!.violations;
    expect(bulletV).toHaveLength(1);
    expect(summaryV).toHaveLength(1);
    expect(bulletV[0]!.id).not.toBe(summaryV[0]!.id);
  });
});

describe('buildDocument', () => {
  it('applies the plan when every change is accepted', () => {
    const doc = buildDocument(profile, plan, buildChanges(profile, plan));
    const text = documentToText(doc);
    expect(text).toContain('Backend engineer focused on billing systems.');
    expect(text).toContain('Migrated billing to PostgreSQL.');
    expect(text).not.toContain('Mentored three engineers.');
    expect(text).not.toContain('初 Labs');
    expect(text).not.toContain('Ruby');
  });

  it('reverts exactly one change when that change is rejected', () => {
    const changes = buildChanges(profile, plan).map((c) =>
      c.id === 'bullet-text:blt_1' ? { ...c, status: 'rejected' as const, reviewed: true } : c,
    );
    const text = documentToText(buildDocument(profile, plan, changes));
    expect(text).toContain('Led the billing migration to PostgreSQL.');
    expect(text).not.toContain('Migrated billing to PostgreSQL.');
    // Everything else is untouched.
    expect(text).not.toContain('Mentored three engineers.');
    expect(text).toContain('Backend engineer focused on billing systems.');
  });

  it('restores a dropped bullet when the drop is rejected', () => {
    const changes = buildChanges(profile, plan).map((c) =>
      c.id === 'bullet-drop:blt_2' ? { ...c, status: 'rejected' as const, reviewed: true } : c,
    );
    expect(documentToText(buildDocument(profile, plan, changes))).toContain('Mentored three engineers.');
  });

  it('restores a dropped employer when the drop is rejected', () => {
    const changes = buildChanges(profile, plan).map((c) =>
      c.id === 'entry-drop:wrk_2' ? { ...c, status: 'rejected' as const, reviewed: true } : c,
    );
    expect(documentToText(buildDocument(profile, plan, changes))).toContain('初 Labs');
  });

  it('discards skill keywords the model invented, even if the change is accepted', () => {
    const bad = structuredClone(plan);
    bad.skills[0]!.keywords = ['Go', 'Kubernetes'];
    const doc = buildDocument(profile, bad, buildChanges(profile, bad));
    const group = doc.sections.find((s) => s.kind === 'skills')!.skills![0]!;
    expect(group.keywords).toEqual(['Go']);
  });

  it('renders every section even when the plan omits one from its ordering', () => {
    const partial = structuredClone(plan);
    partial.sectionOrder = ['work'];
    const doc = buildDocument(profile, partial, buildChanges(profile, partial));
    const keys = doc.sections.map((s) => s.key);
    expect(keys[0]).toBe('work');
    expect(keys).toContain('summary');
    expect(keys).toContain('skills');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('puts contact details in the body, never in a header', () => {
    const doc = buildDocument(profile, plan, buildChanges(profile, plan));
    expect(doc.contact.details).toContain('dana@example.com');
  });

  it('is a pure function of its inputs', () => {
    const changes = buildChanges(profile, plan);
    expect(buildDocument(profile, plan, changes)).toEqual(buildDocument(profile, plan, changes));
  });
});

describe('blockingChanges', () => {
  const bad = structuredClone(plan);
  bad.work[0]!.bullets[0]!.text = 'Migrated billing on Kubernetes.';

  it('blocks while an accepted change carries an unacknowledged violation', () => {
    expect(blockingChanges(buildChanges(profile, bad))).toHaveLength(1);
  });

  it('clears once the user vouches for that specific violation', () => {
    const changes = buildChanges(profile, bad).map((c) =>
      c.id === 'bullet-text:blt_1'
        ? { ...c, acknowledged: c.violations.map((v) => v.id), reviewed: true }
        : c,
    );
    expect(blockingChanges(changes)).toHaveLength(0);
  });

  it('clears when the offending change is rejected instead', () => {
    const changes = buildChanges(profile, bad).map((c) =>
      c.id === 'bullet-text:blt_1' ? { ...c, status: 'rejected' as const, reviewed: true } : c,
    );
    expect(blockingChanges(changes)).toHaveLength(0);
  });

  it('does not clear when a different violation is acknowledged', () => {
    const changes = buildChanges(profile, bad).map((c) =>
      c.id === 'bullet-text:blt_1' ? { ...c, acknowledged: ['some:other:id'] } : c,
    );
    expect(blockingChanges(changes)).toHaveLength(1);
  });
});

describe('writeBackVariants', () => {
  function runWith(changes: TailorRun['changes']): TailorRun {
    return {
      id: 'run_1',
      profileId: profile.id,
      createdAt: '2026-02-01T00:00:00Z',
      providerId: 'anthropic',
      model: 'claude-opus-5',
      jd: { title: 'Backend Engineer', company: 'Globex', location: '', url: '', text: '', source: 'paste' },
      constraints: { pageTarget: 1, tone: 'plain', seniority: '' },
      plan,
      changes,
      notes: '',
    };
  }

  it('appends an accepted rephrasing as a variant without touching the canonical text', () => {
    const changes = buildChanges(profile, plan).map((c) =>
      c.id === 'bullet-text:blt_1' ? { ...c, reviewed: true } : c,
    );
    const next = writeBackVariants(profile, runWith(changes));
    const bullet = next.work[0]!.bullets[0]!;
    expect(bullet.text).toBe('Led the billing migration to PostgreSQL.');
    expect(bullet.variants).toHaveLength(1);
    expect(bullet.variants[0]!.text).toBe('Migrated billing to PostgreSQL.');
    expect(bullet.variants[0]!.note).toBe('Backend Engineer · Globex');
  });

  it('does not write back an unreviewed change', () => {
    const next = writeBackVariants(profile, runWith(buildChanges(profile, plan)));
    expect(next.work[0]!.bullets[0]!.variants).toHaveLength(0);
  });

  it('does not write back a rejected change', () => {
    const changes = buildChanges(profile, plan).map((c) =>
      c.id === 'bullet-text:blt_1' ? { ...c, status: 'rejected' as const, reviewed: true } : c,
    );
    expect(writeBackVariants(profile, runWith(changes)).work[0]!.bullets[0]!.variants).toHaveLength(0);
  });

  it('does not store the same phrasing twice across runs', () => {
    const changes = buildChanges(profile, plan).map((c) =>
      c.id === 'bullet-text:blt_1' ? { ...c, reviewed: true } : c,
    );
    const once = writeBackVariants(profile, runWith(changes));
    const twice = writeBackVariants(once, runWith(changes));
    expect(twice.work[0]!.bullets[0]!.variants).toHaveLength(1);
  });

  it('leaves the profile untouched when nothing was accepted', () => {
    expect(writeBackVariants(profile, runWith([]))).toBe(profile);
  });
});
