import { describe, it, expect } from 'vitest';
import { extractRequirements, buildCoverage } from './coverage';
import { profileSchema } from '../schema';

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

  it('detects plain capitalised technologies with no distinguishing shape', () => {
    // Most tech names are ordinary capitalised words — no internal capital, no
    // acronym, no punctuation. Detecting these must not depend on them
    // happening to sit next to a phrase like "experience with".
    const norms = extractRequirements(
      'The stack is Kubernetes, Terraform, Django and Kafka. Deploys run nightly.',
    ).map((t) => t.norm);
    expect(norms).toEqual(expect.arrayContaining(['kubernetes', 'terraform', 'django', 'kafka']));
  });

  it('still excludes imperative verbs that open a requirement bullet', () => {
    const norms = extractRequirements(
      '• Design and build scalable systems\n• Mentor engineers\n• Own delivery end to end',
    ).map((t) => t.norm);
    for (const verb of ['design', 'build', 'mentor', 'own', 'scalable']) {
      expect(norms).not.toContain(verb);
    }
  });

  it('excludes capitalised job-posting boilerplate nouns', () => {
    // These open sentences constantly, so they arrive capitalised and would
    // otherwise be mistaken for named technologies.
    const norms = extractRequirements(
      'Familiarity with Terraform is required. Proficiency in Go expected. Knowledge of Kafka helps. Responsibilities include on-call.',
    ).map((t) => t.norm);
    for (const w of ['familiarity', 'proficiency', 'knowledge', 'responsibilities']) {
      expect(norms).not.toContain(w);
    }
    expect(norms).toEqual(expect.arrayContaining(['terraform', 'kafka']));
  });

  it('excludes ordinary verbs that open a sentence in a posting', () => {
    // Caught by running the published package against a real posting: "Need
    // Kubernetes and Rust" was reporting "Need" as a required skill.
    const norms = extractRequirements(
      'Need Kubernetes and Rust. Looking for someone great. We offer equity. Bring curiosity.',
    ).map((t) => t.norm);
    for (const w of ['need', 'looking', 'offer', 'bring']) expect(norms).not.toContain(w);
    expect(norms).toEqual(expect.arrayContaining(['kubernetes', 'rust']));
  });

  it('keeps technology names that collide with ordinary verbs', () => {
    // Guards the regression note in stopwords.ts: adding `go` to the
    // sentence-opener allowlist silently stopped Go being recognised at all.
    const norms = extractRequirements('You will write Go and Rust daily.').map((t) => t.norm);
    expect(norms).toEqual(expect.arrayContaining(['go', 'rust']));
  });

  it('excludes sentence-opening pronouns and boilerplate', () => {
    const norms = extractRequirements('We are hiring. You will report to the Engineering lead.').map(
      (t) => t.norm,
    );
    for (const w of ['we', 'you', 'the', 'are', 'hiring']) expect(norms).not.toContain(w);
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

/**
 * Four defects found by running real postings through this module, each of
 * which had shipped and none of which the unit tests above caught. They are
 * grouped because they share a cause: the requirement extractor was reading a
 * posting as a bag of words near cue phrases, rather than as a document with a
 * title, requirement lines, and a wish list.
 */
describe('reading a posting as a document', () => {
  const POSTING = `Senior Platform Engineer — Meridian Logistics

What we need
- Strong experience with Go in production. This is most of what we write.
- Deep PostgreSQL knowledge — required. Sharding, replication, query planning.
- Experience with Kafka or a comparable event streaming system.

Nice to have
- Payments or logistics domain background.
- Experience with Datadog for observability.
`;

  const emphasised = () =>
    extractRequirements(POSTING)
      .filter((t) => t.emphasised)
      .map((t) => t.norm);

  it('does not treat the hiring company as a skill the candidate lacks', () => {
    // "Senior Platform Engineer — Meridian Logistics" reported Meridian as an
    // unmet requirement.
    expect(extractRequirements(POSTING).map((t) => t.norm)).not.toContain('meridian');
  });

  it('reads a requirement whose cue comes after it', () => {
    // "Deep PostgreSQL knowledge — required" states a hard requirement with the
    // cue trailing. A window running forward from each cue could never see it.
    expect(emphasised()).toContain('postgresql');
  });

  it('does not promote the degree word to the requirement', () => {
    // The requirement is PostgreSQL. "Deep" qualifies it.
    expect(emphasised()).not.toContain('deep');
  });

  it('does not let a requirement line bleed into the next one', () => {
    expect(emphasised()).toEqual(expect.arrayContaining(['go', 'postgresql', 'kafka']));
  });

  it('keeps a wish list out of the hard requirements', () => {
    // Both sit under "Nice to have" and both are introduced by cue phrases
    // identical to the ones above it.
    expect(emphasised()).not.toContain('datadog');
    expect(emphasised()).not.toContain('payments');
  });
});

describe('matching a requirement to evidence', () => {
  const profile = profileSchema.parse({
    id: 'prf_1',
    createdAt: 'now',
    updatedAt: 'now',
    work: [
      {
        id: 'wrk_1',
        name: 'Harbor Freight',
        position: 'Engineer',
        bullets: [
          { id: 'blt_1', text: 'Resharded the shipment ledger in PostgreSQL behind a dual-write cutover.' },
          { id: 'blt_2', text: 'Owned the Kafka ingestion pipeline for carrier events.' },
        ],
      },
    ],
  });

  it('credits work described in a different grammatical form', () => {
    // The posting says "Sharding"; the profile says "Resharded". Reporting that
    // as a gap tells someone to go learn a thing they have already done — and
    // `missing` is documented to mean they genuinely have not.
    const report = buildCoverage('Sharding is required. Experience with sharding at scale.', [], profile);
    expect(report.missing.map((t) => t.norm)).not.toContain('sharding');
  });

  it('still reports something the profile genuinely lacks', () => {
    // The looser match must not turn into "everything counts".
    const report = buildCoverage('Experience with Kubernetes is required.', [], profile);
    expect(report.missing.map((t) => t.norm)).toContain('kubernetes');
  });

  it('does not collapse a technology into an unrelated shorter word', () => {
    // Stripping "-er" would make "Docker" match a profile that only says "dock".
    const docks = profileSchema.parse({
      ...profile,
      work: [{ ...profile.work[0], bullets: [{ id: 'blt_1', text: 'Managed the loading dock schedule.' }] }],
    });
    const report = buildCoverage('Experience with Docker is required.', [], docks);
    expect(report.missing.map((t) => t.norm)).toContain('docker');
  });
});
