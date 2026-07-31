import { describe, it, expect } from 'vitest';
import { checkText, profileLexicon } from './guard';
import { buildLexicon, tokenize, equivalentForms } from './lexicon';
import { profileSchema, type Profile } from '../schema';

function makeProfile(over: Partial<Profile> = {}): Profile {
  return profileSchema.parse({
    id: 'prf_test',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    basics: {
      name: 'Dana Reyes',
      summary: 'Backend engineer focused on distributed systems.',
      email: 'dana@example.com',
    },
    work: [
      {
        id: 'wrk_1',
        name: 'Acme Robotics',
        position: 'Senior Engineer',
        startDate: '2021-03',
        endDate: '2024-11',
        bullets: [
          {
            id: 'blt_1',
            text: 'Led the migration of the billing service to PostgreSQL, cutting p99 latency by 40%.',
            tags: ['databases'],
            variants: [],
          },
          {
            id: 'blt_2',
            text: 'Built CI/CD pipelines in GitHub Actions for 12 services.',
            tags: ['infra'],
            variants: [],
          },
        ],
      },
    ],
    skills: [{ id: 'skl_1', name: 'Languages', keywords: ['Go', 'Python', 'Node.js', 'C++'] }],
    ...over,
  });
}

describe('tokenize', () => {
  it('keeps technology tokens intact', () => {
    const norms = tokenize('We used Node.js, C++, CI/CD and .NET here.').map((t) => t.norm);
    expect(norms).toContain('node.js');
    expect(norms).toContain('c++');
    expect(norms).toContain('ci/cd');
    expect(norms).toContain('.net');
  });

  it('strips possessives and trailing punctuation', () => {
    const norms = tokenize("Google's platform, and Stripe.").map((t) => t.norm);
    expect(norms).toContain('google');
    expect(norms).toContain('stripe');
  });

  it('marks sentence starts', () => {
    const toks = tokenize('Led the work. Directed the rest');
    expect(toks[0]!.sentenceStart).toBe(true);
    expect(toks[1]!.sentenceStart).toBe(false);
    const directed = toks.find((t) => t.norm === 'directed')!;
    expect(directed.sentenceStart).toBe(true);
  });

  it('treats bullet delimiters as sentence boundaries', () => {
    const toks = tokenize('Shipped the thing • Datadog dashboards');
    expect(toks.find((t) => t.norm === 'datadog')!.sentenceStart).toBe(true);
  });
});

describe('equivalentForms', () => {
  it('folds percentages, currency and magnitudes onto the bare number', () => {
    expect(equivalentForms('40%')).toContain('40');
    expect(equivalentForms('$1.2m')).toContain('1.2');
    expect(equivalentForms('1,200')).toContain('1200');
    expect(equivalentForms('3x')).toContain('3');
  });

  it('folds simple plurals', () => {
    expect(equivalentForms('apis')).toContain('api');
    expect(equivalentForms('api')).toContain('apis');
  });
});

describe('fabrication guard', () => {
  const lexicon = profileLexicon(makeProfile());

  it('passes text that only reorders and rephrases grounded facts', () => {
    const { violations } = checkText(
      'Migrated the billing service to PostgreSQL, reducing p99 latency 40%.',
      lexicon,
    );
    expect(violations).toEqual([]);
  });

  it('accepts a rephrased action verb at the start of a line', () => {
    const { violations } = checkText('Directed the billing service migration.', lexicon);
    expect(violations).toEqual([]);
  });

  it('flags a fabricated employer', () => {
    const { violations } = checkText('Led platform work at Datadog and Acme Robotics.', lexicon);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.token).toBe('Datadog');
    expect(violations[0]!.kind).toBe('proper-noun');
    expect(violations[0]!.severity).toBe('high');
  });

  it('flags a fabricated technology even when it looks plausible', () => {
    const { violations } = checkText('Built services in Kubernetes and Go.', lexicon);
    expect(violations.map((v) => v.token)).toEqual(['Kubernetes']);
  });

  it('flags an invented metric', () => {
    const { violations } = checkText('Cut latency by 65% across the fleet.', lexicon);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('number');
    expect(violations[0]!.severity).toBe('high');
  });

  it('flags an invented date', () => {
    const { violations } = checkText('Worked at Acme Robotics from 2019 to 2024.', lexicon);
    expect(violations.map((v) => v.token)).toEqual(['2019']);
  });

  it('accepts a number that is grounded in a different notation', () => {
    // Profile says "40%"; output says "40 percent".
    const { violations } = checkText('Reduced latency 40 percent.', lexicon);
    expect(violations).toEqual([]);
  });

  it('accepts acronym pluralisation', () => {
    const p = makeProfile();
    p.work[0]!.bullets[0]!.text = 'Maintained the public API.';
    const { violations } = checkText('Maintained public APIs.', profileLexicon(p));
    expect(violations).toEqual([]);
  });

  it('flags an unknown all-caps acronym', () => {
    const { violations } = checkText('Owned the SOC2 audit.', lexicon);
    expect(violations.map((v) => v.token)).toEqual(['SOC2']);
  });

  it('flags an unrecognised capitalised line opener at medium severity', () => {
    const { violations } = checkText('Terraform modules for the fleet', lexicon);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.severity).toBe('medium');
    expect(violations[0]!.kind).toBe('unverified-capital');
  });

  it('does not flag calendar words', () => {
    const { violations } = checkText('Shipped in March and continued to Present.', lexicon);
    expect(violations).toEqual([]);
  });

  it('reports each distinct token once per scope', () => {
    const { violations } = checkText('Datadog here. Datadog there. Datadog everywhere.', lexicon);
    expect(violations).toHaveLength(1);
  });

  it('namespaces violation ids by scope so changes stay independent', () => {
    const a = checkText('Used Kubernetes.', lexicon, 'chg_1');
    const b = checkText('Used Kubernetes.', lexicon, 'chg_2');
    expect(a.violations[0]!.id).not.toBe(b.violations[0]!.id);
    expect(a.violations[0]!.id.startsWith('chg_1:')).toBe(true);
  });

  it('grounds tokens that appear anywhere in the profile, not just bullets', () => {
    // "Go" only appears in the skills section.
    const { violations } = checkText('Wrote services in Go.', lexicon);
    expect(violations).toEqual([]);
  });

  it('treats an empty string as clean', () => {
    expect(checkText('', lexicon).violations).toEqual([]);
  });
});

describe('buildLexicon', () => {
  it('walks nested structures', () => {
    const lex = buildLexicon({ a: ['Stripe'], b: { c: { d: 'Datadog' } } });
    expect(lex.has('stripe')).toBe(true);
    expect(lex.has('datadog')).toBe(true);
  });
});
