import { describe, it, expect } from 'vitest';
import { checkText } from './guard';
import { buildLexicon } from './lexicon';
import { SENTENCE_START_ALLOWLIST } from './stopwords';

/**
 * The sentence-opener allowlist, pushed from both sides.
 *
 * Every entry on this list is a detection deliberately given up: at the start
 * of a sentence "Directed" and "Datadog" are morphologically identical, so a
 * word that is exempted can never be caught there again. That makes the list
 * the easiest place in the codebase to quietly disable the fabrication guard —
 * add enough words and it stops firing, and every test still passes.
 *
 * So it is tested in both directions. The first block is ordinary English that
 * must not be flagged; the second is invented names that must be, and it is the
 * one that matters. A change that makes the first block pass by breaking the
 * second has made the guard worse, not better.
 */

/** A profile with a small, known vocabulary. */
const lexicon = buildLexicon({
  work: [
    {
      name: 'Harbor Freight',
      position: 'Senior Engineer',
      bullets: [
        { text: 'Resharded the ledger in PostgreSQL, cutting p99 latency to 120ms.' },
        { text: 'Owned the Kafka pipeline carrying 60 million carrier events per day.' },
      ],
    },
  ],
  skills: [{ name: 'Languages', keywords: ['Go', 'PostgreSQL', 'Kafka'] }],
});

const openers = (text: string) =>
  checkText(text, lexicon, 't').violations.map((v) => v.token);

describe('ordinary English that must not be flagged', () => {
  // Each of these is a real sentence shape from a generated resume. The
  // adjective and adverb cases are the ones the list was missing.
  const legitimate = [
    'Additional experience with distributed systems.',
    'Comfortable owning a service end to end.',
    'Enjoys mentoring engineers through their first on-call rotation.',
    'Currently focused on reliability work.',
    'Previously responsible for the deploy pipeline.',
    'Experienced backend engineer with a bias for simple systems.',
    'Successfully reduced deployment time.',
    'Consistently delivered ahead of schedule.',
    'Senior engineer with deep database experience.',
    'Deeply familiar with query planning.',
    'Proven track record of shipping.',
    'Highly collaborative across teams.',
    'Directed the migration to a sharded design.',
    'Partnered with product teams before they shipped.',
  ];

  it.each(legitimate)('%s', (sentence) => {
    expect(openers(sentence)).toEqual([]);
  });
});

describe('invented names that must still be caught', () => {
  // The list buys nothing if it also exempts these. Every one is a plausible
  // fabrication sitting in the position the allowlist governs.
  const fabricated: Array<[string, string]> = [
    ['Datadog dashboards tracked every service.', 'Datadog'],
    ['Kubernetes ran the whole platform.', 'Kubernetes'],
    ['Terraform defined all infrastructure.', 'Terraform'],
    ['Snowflake warehoused the events.', 'Snowflake'],
    ['Grafana surfaced the alerts.', 'Grafana'],
    ['Databricks handled the batch jobs.', 'Databricks'],
  ];

  it.each(fabricated)('%s', (sentence, token) => {
    expect(openers(sentence)).toContain(token);
  });

  it('still catches a fabrication mid-sentence at high severity', () => {
    const violations = checkText('Built the pipeline on Databricks.', lexicon, 't').violations;
    expect(violations[0]).toMatchObject({ token: 'Databricks', severity: 'high' });
  });

  it('still catches an invented number', () => {
    const violations = checkText('Cut latency by 94 percent.', lexicon, 't').violations;
    expect(violations.map((v) => v.token)).toContain('94');
  });
});

describe('the list itself', () => {
  it('contains no technology name that would mask a real fabrication', () => {
    // The docblock names these specifically: each is both an ordinary English
    // word and a language or product, and listing one costs a real detection.
    const traps = [
      'go', 'rust', 'swift', 'dart', 'ruby', 'julia', 'crystal', 'elm', 'nim',
      'react', 'angular', 'ember', 'meteor', 'spark', 'storm', 'kafka', 'hadoop',
    ];
    expect(traps.filter((t) => SENTENCE_START_ALLOWLIST.has(t))).toEqual([]);
  });

  it('holds only single lowercase words', () => {
    // A stray comma or capital from an edited comment silently adds a token
    // nobody intended to exempt — which is how "Firebase" nearly got on it.
    const malformed = [...SENTENCE_START_ALLOWLIST].filter((w) => !/^[a-z-]+$/.test(w));
    expect(malformed).toEqual([]);
  });
});
