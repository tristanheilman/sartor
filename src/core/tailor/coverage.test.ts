import { describe, it, expect } from 'vitest';
import { extractRequirements, buildCoverage } from './coverage';
import { profileSchema } from '@/core/schema';

const JD = `
Senior Backend Engineer

We are looking for someone with strong experience in PostgreSQL and Go.
You will work with Kubernetes daily. Familiarity with Terraform is required.
Nice to have: exposure to gRPC.
`;

const profile = profileSchema.parse({
  id: 'prf_1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  basics: { name: 'Dana Reyes' },
  work: [
    {
      id: 'wrk_1',
      name: 'Acme Robotics',
      position: 'Senior Engineer',
      bullets: [
        { id: 'blt_1', text: 'Migrated the billing service to PostgreSQL.', tags: [], variants: [] },
        { id: 'blt_2', text: 'Wrote internal tooling in Go.', tags: [], variants: [] },
      ],
    },
  ],
  skills: [{ id: 'skl_1', name: 'Infra', keywords: ['Terraform'] }],
});

describe('extractRequirements', () => {
  it('surfaces technology terms from the posting', () => {
    const norms = extractRequirements(JD).map((t) => t.norm);
    expect(norms).toContain('postgresql');
    expect(norms).toContain('kubernetes');
    expect(norms).toContain('terraform');
    expect(norms).toContain('grpc');
  });

  it('does not surface boilerplate', () => {
    const norms = extractRequirements(JD).map((t) => t.norm);
    expect(norms).not.toContain('experience');
    expect(norms).not.toContain('engineer');
    expect(norms).not.toContain('required');
  });

  it('marks terms in a requirement clause as emphasised', () => {
    const pg = extractRequirements(JD).find((t) => t.norm === 'postgresql');
    expect(pg?.emphasised).toBe(true);
  });
});

describe('buildCoverage', () => {
  const slices = [
    { label: 'Experience · Acme Robotics', text: 'Migrated the billing service to PostgreSQL.' },
  ];
  const report = buildCoverage(JD, slices, profile);

  it('reports terms that appear in the tailored resume, with location', () => {
    const pg = report.terms.find((t) => t.norm === 'postgresql')!;
    expect(pg.status).toBe('present');
    expect(pg.locations).toEqual(['Experience · Acme Robotics']);
  });

  it('separates terms the user has but did not include in this version', () => {
    const norms = report.inProfileOnly.map((t) => t.norm);
    expect(norms).toContain('terraform');
    expect(norms).toContain('go');
  });

  it('reports genuine gaps as missing, not as something to fix', () => {
    const norms = report.missing.map((t) => t.norm);
    expect(norms).toContain('kubernetes');
    expect(norms).toContain('grpc');
  });

  it('partitions every term exactly once', () => {
    const total = report.present.length + report.inProfileOnly.length + report.missing.length;
    expect(total).toBe(report.terms.length);
  });

  it('never invents a score', () => {
    expect(report).not.toHaveProperty('score');
  });
});
