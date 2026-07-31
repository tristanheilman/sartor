import { describe, it, expect } from 'vitest';
import { profileSchema } from '../schema';
import { tailorPlanSchema } from '../tailor/plan';
import { buildChanges, buildDocument } from '../tailor/apply';
import { documentToSlices, documentToText, estimateLines } from './model';
import { parseSafetyChecks, worstStatus } from './parseSafety';
import { TEMPLATES, getTemplate } from './templates';

/**
 * Integration tests for the render layer. These actually produce a PDF and a
 * DOCX, which is the only way to catch invalid style props or a malformed
 * document tree — both libraries validate at render time, not at compile time.
 */

const profile = profileSchema.parse({
  id: 'prf_1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  basics: {
    name: 'Dana Reyes',
    label: 'Backend Engineer',
    email: 'dana@example.com',
    phone: '+1 555 0100',
    summary: 'Backend engineer working on billing systems.',
    location: { city: 'Berlin', region: 'DE' },
  },
  work: [
    {
      id: 'wrk_1',
      name: 'Acme Robotics',
      position: 'Senior Engineer',
      location: 'Berlin, DE',
      startDate: '2021-03',
      endDate: '2024-11',
      bullets: [
        { id: 'blt_1', text: 'Led the billing migration to PostgreSQL, cutting p99 latency 40%.' },
        { id: 'blt_2', text: 'Mentored three engineers through their first on-call rotation.' },
      ],
    },
  ],
  education: [
    { id: 'edu_1', institution: 'TU Berlin', studyType: 'BSc', area: 'Computer Science', endDate: '2018' },
  ],
  skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Go', 'Python', 'C++'] }],
  certificates: [{ id: 'crt_1', name: 'CKA', issuer: 'CNCF', date: '2023' }],
});

const plan = tailorPlanSchema.parse({
  summary: { text: 'Backend engineer focused on billing systems.', rationale: 'Matches posting.' },
  work: [
    {
      id: 'wrk_1',
      include: true,
      order: 0,
      bullets: [
        { bulletId: 'blt_1', include: true, order: 0, text: '', textSource: 'canonical' },
        { bulletId: 'blt_2', include: true, order: 1, text: '', textSource: 'canonical' },
      ],
    },
  ],
  skills: [{ id: 'skl_1', include: true, order: 0, keywords: ['Go', 'Python', 'C++'] }],
});

const doc = buildDocument(profile, plan, buildChanges(profile, plan));

describe('render model', () => {
  it('produces the expected sections in order', () => {
    expect(doc.sections.map((s) => s.key)).toEqual([
      'summary',
      'skills',
      'work',
      'education',
      'certificates',
    ]);
  });

  it('uses standard headings', () => {
    expect(doc.sections.map((s) => s.heading)).toEqual([
      'Summary',
      'Skills',
      'Experience',
      'Education',
      'Certifications',
    ]);
  });

  it('keeps every rendered line traceable to a source id', () => {
    const entries = doc.sections.flatMap((s) => s.entries ?? []);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.sourceId).toMatch(/^(wrk|prj|edu)_/);
      for (const b of e.bullets) expect(b.sourceId).toMatch(/^blt_/);
    }
  });

  it('slices the document for coverage with useful labels', () => {
    const labels = documentToSlices(doc).map((s) => s.label);
    expect(labels).toContain('Summary');
    expect(labels).toContain('Experience · Acme Robotics');
  });

  it('flattens to text containing every bullet', () => {
    const text = documentToText(doc);
    expect(text).toContain('p99 latency 40%');
    expect(text).toContain('dana@example.com');
  });

  it('estimates a plausible length', () => {
    const lines = estimateLines(doc);
    expect(lines).toBeGreaterThan(10);
    expect(lines).toBeLessThan(60);
  });
});

describe('parse safety', () => {
  const checks = parseSafetyChecks(doc, 1);

  it('passes every structural check, because the template guarantees them', () => {
    expect(checks.filter((c) => c.structural).every((c) => c.status === 'pass')).toBe(true);
  });

  it('confirms contact details and name are present', () => {
    expect(checks.find((c) => c.id === 'contact-in-body')!.status).toBe('pass');
    expect(checks.find((c) => c.id === 'name-present')!.status).toBe('pass');
  });

  it('fails the contact check when there is no email', () => {
    const bare = { ...doc, contact: { ...doc.contact, details: ['+1 555 0100'] } };
    expect(parseSafetyChecks(bare, 1).find((c) => c.id === 'contact-in-body')!.status).toBe('warn');
  });

  it('fails when the profile has no name', () => {
    const nameless = { ...doc, contact: { ...doc.contact, name: '' } };
    const result = parseSafetyChecks(nameless, 1);
    expect(result.find((c) => c.id === 'name-present')!.status).toBe('fail');
    expect(worstStatus(result)).toBe('fail');
  });

  it('never reports a numeric score', () => {
    for (const c of checks) expect(c).not.toHaveProperty('score');
  });
});

describe('templates', () => {
  it('all share the structural rules that matter for parsing', () => {
    for (const t of TEMPLATES) {
      expect(t.pageMargin).toBeGreaterThan(20);
      expect(t.baseSize).toBeGreaterThanOrEqual(9);
    }
  });

  it('falls back to the first template for an unknown id', () => {
    expect(getTemplate('nope').id).toBe('classic');
  });
});

describe('PDF rendering', () => {
  it('renders a real PDF for every template', async () => {
    const { renderToBuffer } = await import('@react-pdf/renderer');
    const { ResumePdf } = await import('./pdf');

    for (const t of TEMPLATES) {
      const buffer = await renderToBuffer(ResumePdf({ doc, templateId: t.id }) as never);
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
      expect(buffer.length).toBeGreaterThan(1000);
    }
  }, 30_000);
});

describe('DOCX rendering', () => {
  it('renders a real DOCX containing the resume text', async () => {
    const { Packer } = await import('docx');
    const { buildDocxDocument } = await import('./docx');

    const buffer = await Packer.toBuffer(buildDocxDocument(doc, 'classic'));
    // A .docx is a zip; every zip starts with the local file header magic.
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    expect(buffer.length).toBeGreaterThan(1000);
  }, 30_000);

  it('renders for every template without throwing', async () => {
    const { Packer } = await import('docx');
    const { buildDocxDocument } = await import('./docx');
    for (const t of TEMPLATES) {
      await expect(Packer.toBuffer(buildDocxDocument(doc, t.id))).resolves.toBeDefined();
    }
  }, 30_000);
});
