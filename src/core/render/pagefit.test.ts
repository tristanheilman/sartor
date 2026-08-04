import { describe, it, expect } from 'vitest';
import { getTemplate, TEMPLATES } from './templates';
import { linesPerPage } from './model';
import { parseSafetyChecks } from './parseSafety';
import type { ResumeDocument } from './model';

/**
 * The page-fit check, which used to give advice it could not act on.
 *
 * `estimateLines` took only the document and compared it against a single
 * `LINES_PER_PAGE` constant, so every template produced the same verdict — and
 * the warning's own remedy was "switch to the Compact template". Switching
 * changed nothing, because the estimate never looked at which template was
 * selected. Advice that provably cannot work is worse than no advice: it sends
 * someone round a loop that has no exit.
 *
 * Templates already carry the metrics this needs — `baseSize`, `lineHeight`
 * and `pageMargin` are bounded by the schema, so the arithmetic is real rather
 * than a fudge factor.
 */

const doc = (bullets: number): ResumeDocument => ({
  contact: {
    name: 'Tristan Heilman',
    label: 'Mobile Developer',
    details: ['tristan@example.com', 'Cincinnati, OH'],
  },
  sections: [
    {
      key: 'work',
      heading: 'Experience',
      kind: 'entries',
      entries: [
        {
          sourceId: 'wrk_1',
          primary: 'Native App Developer',
          secondary: 'Formedics',
          meta: '10/2025 - Present',
          aside: 'Remote',
          summary: '',
          bullets: Array.from({ length: bullets }, (_, i) => ({
            sourceId: `b${i}`,
            text: 'Owned the release cycle for the mobile application across iOS and Android.',
          })),
        },
      ],
    },
  ],
});

describe('lines per page', () => {
  it('is computed from the template rather than fixed', () => {
    const classic = linesPerPage(getTemplate('classic'));
    const compact = linesPerPage(getTemplate('compact'));

    expect(compact).toBeGreaterThan(classic);
  });

  it('gives every built-in template a sane page', () => {
    // A resume that fits three lines, or two hundred, means the arithmetic is
    // wrong somewhere rather than the template being unusual.
    for (const t of TEMPLATES) {
      const n = linesPerPage(t);
      expect(n, t.id).toBeGreaterThan(30);
      expect(n, t.id).toBeLessThan(110);
    }
  });

  it('gives Roomy fewer lines than Classic', () => {
    expect(linesPerPage(getTemplate('roomy'))).toBeLessThan(linesPerPage(getTemplate('classic')));
  });
});

describe('the page-fit warning', () => {
  const fit = (d: ResumeDocument, templateId: string) =>
    parseSafetyChecks(d, 1, getTemplate(templateId)).find((c) => c.id === 'length')!;

  it('passes a short resume on any template', () => {
    expect(fit(doc(4), 'classic').status).toBe('pass');
  });

  it('warns when the document genuinely does not fit', () => {
    expect(fit(doc(120), 'compact').status).toBe('warn');
  });

  it('changes its verdict when a denser template is chosen', () => {
    // The whole point. There has to exist a document that overflows Classic and
    // fits Compact, or the advice is a dead end.
    const sizes = [30, 40, 45, 50, 55, 60];
    const flips = sizes.some(
      (n) => fit(doc(n), 'classic').status === 'warn' && fit(doc(n), 'compact').status === 'pass',
    );
    expect(flips).toBe(true);
  });

  it('stops telling you to switch to Compact once you are on it', () => {
    const warned = fit(doc(120), 'compact');
    expect(warned.status).toBe('warn');
    expect(warned.detail).not.toMatch(/switch to the Compact template/i);
  });

  it('still suggests Compact from a roomier template', () => {
    expect(fit(doc(120), 'classic').detail).toMatch(/Compact/);
  });
});

describe('a document with no page target', () => {
  /**
   * The master profile is deliberately long — it is the superset every tailored
   * version is selected from. Warning that it does not fit one page is not a
   * finding, it is the point of the document.
   */
  it('skips the length check entirely', () => {
    const checks = parseSafetyChecks(doc(200), null, getTemplate('classic'));
    expect(checks.find((c) => c.id === 'length')).toBeUndefined();
  });

  it('still runs every other parse check', () => {
    const withTarget = parseSafetyChecks(doc(10), 1, getTemplate('classic')).map((c) => c.id);
    const without = parseSafetyChecks(doc(10), null, getTemplate('classic')).map((c) => c.id);

    expect(without).toEqual(withTarget.filter((id) => id !== 'length'));
    expect(without).toContain('single-column');
    expect(without).toContain('name-present');
  });
});
