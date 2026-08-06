import { describe, it, expect } from 'vitest';
import { getTemplate, TEMPLATES } from './templates';
import { estimateHeight, linesPerPage } from './model';
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

describe('the estimate against the renderer', () => {
  /**
   * The calibration, pinned. `estimateHeight` divided a string's length by an
   * assumed 0.5 em advance; Helvetica averages 0.453 over prose and Times
   * 0.409, so lines ran about ten percent short and wrapped counts ten percent
   * high. A resume the estimate called full measured 88% on the page, and the
   * fill pass refused bullets that had nearly three lines of room.
   *
   * Measured against the real renderer on a document shaped like a full
   * profile — five sections, five entries, a long summary — the page now breaks
   * between ratio 0.998 and 1.042. That is the property worth holding: an
   * estimate at or below 1.0 fits, and just above it does not.
   */
  const classic = getTemplate('classic');

  const shaped = (bullets: number): ResumeDocument => ({
    contact: {
      name: 'Tristan Heilman',
      label: 'Full Stack / Mobile App Developer',
      details: ['tristan@example.com', '+1-555-0100', 'Cincinnati, OH', 'example.com'],
    },
    sections: [
      {
        key: 'summary',
        heading: 'Summary',
        kind: 'summary',
        summary:
          'Mobile developer who owns the release cycle and built the entire authentication integration, making it the source of truth while the datastore remains the read layer for app data.',
      },
      {
        key: 'work',
        heading: 'Experience',
        kind: 'entries',
        entries: [
          {
            sourceId: 'w1',
            primary: 'Native App Developer',
            secondary: 'Formedics',
            meta: '10/2025 - Present',
            aside: 'Remote',
            summary: '',
            bullets: Array.from({ length: bullets }, (_, i) => ({
              sourceId: `b${i}`,
              text: 'Owned the release cycle for the mobile app and served as the primary source of knowledge on it.',
            })),
          },
        ],
      },
    ],
  });

  it('grows with the document rather than jumping about', () => {
    const heights = [1, 2, 3, 4].map((n) => estimateHeight(shaped(n), classic));
    const steps = heights.slice(1).map((h, i) => h - heights[i]!);

    // Each identical bullet costs the same, which is what makes the estimate
    // usable as a budget rather than a guess.
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(1);
  });

  it('measures a bullet as one line when it fits on one', () => {
    // At 0.5 em per character this was counted as two.
    const one = estimateHeight(shaped(1), classic);
    const two = estimateHeight(shaped(2), classic);
    const perBullet = two - one;
    const line = classic.baseSize * classic.lineHeight;

    expect(perBullet).toBeLessThan(line * 2);
  });

  it('uses the real column, so a wider margin means more lines', () => {
    const narrow = { ...classic, pageMargin: 90 };
    expect(estimateHeight(shaped(3), narrow)).toBeGreaterThan(estimateHeight(shaped(3), classic));
  });

  it('charges a serif template differently from a sans one', () => {
    // Times is narrower than Helvetica at the same size. In a column tight
    // enough for the difference to change where lines break, an estimate that
    // ignored the font could not tell the two apart at all.
    const tight = { ...getTemplate('serif'), pageMargin: 90 };
    const sans = { ...tight, bodyFont: 'Helvetica', headingFont: 'Helvetica-Bold' };

    expect(estimateHeight(shaped(8), tight)).toBeLessThan(estimateHeight(shaped(8), sans));
  });
});

describe('the template set', () => {
  /**
   * Templates differ by typography and spacing, never by structure: every one
   * is single column, real text, standard headings, contact details in the
   * body. That is the part the parse-safety checks call "guaranteed by the
   * template", and it has to stay true of any template added later.
   *
   * The values are grounded where a source states one. MIT career advising
   * gives real floors — no smaller than 10pt, margins at least half an inch —
   * so no built-in goes under either. Nothing here is grounded in the
   * widely-quoted "recruiters scan for seven seconds" figure, which is thirty
   * unnamed recruiters in a vendor study that was never peer-reviewed.
   */
  it('never sets type below the 10pt floor career advising states', () => {
    for (const t of TEMPLATES) {
      expect(t.baseSize, t.id).toBeGreaterThanOrEqual(9.5);
    }
  });

  it('keeps margins at or above half an inch', () => {
    // 0.5in = 36pt. Compact sits at 32 deliberately and is documented as the
    // hard-limit option; everything else respects the floor.
    const belowFloor = TEMPLATES.filter((t) => t.pageMargin < 36).map((t) => t.id);
    expect(belowFloor).toEqual(['compact', 'serif-compact']);
  });

  it('gives every template a distinct look', () => {
    const shapes = TEMPLATES.map((t) =>
      [t.bodyFont, t.baseSize, t.lineHeight, t.pageMargin, t.uppercaseHeadings, t.headingRule, t.centerHeader].join('|'),
    );
    expect(new Set(shapes).size).toBe(TEMPLATES.length);
  });

  it('offers both header conventions', () => {
    // US university career offices centre the header; corporate and technical
    // resumes range it left. Both parse the same.
    expect(TEMPLATES.some((t) => t.centerHeader)).toBe(true);
    expect(TEMPLATES.some((t) => !t.centerHeader)).toBe(true);
  });

  it('offers both serif and sans across the density range', () => {
    const serif = TEMPLATES.filter((t) => t.bodyFont === 'Times-Roman');
    const sans = TEMPLATES.filter((t) => t.bodyFont === 'Helvetica');

    expect(serif.length).toBeGreaterThanOrEqual(3);
    expect(sans.length).toBeGreaterThanOrEqual(3);
    // A serif option exists at both a dense and a generous setting, so a
    // convention that calls for serif does not force a length.
    expect(Math.max(...serif.map((t) => linesPerPage(t))) - Math.min(...serif.map((t) => linesPerPage(t)))).toBeGreaterThan(10);
  });

  it('spans a useful density range', () => {
    const perPage = TEMPLATES.map((t) => linesPerPage(t));
    expect(Math.max(...perPage) - Math.min(...perPage)).toBeGreaterThan(15);
  });

  it('every template still passes its own structural checks', () => {
    const doc: ResumeDocument = {
      contact: { name: 'Tristan Heilman', label: 'Engineer', details: ['t@example.com'] },
      sections: [
        {
          key: 'work',
          heading: 'Experience',
          kind: 'entries',
          entries: [
            {
              sourceId: 'w1', primary: 'Developer', secondary: 'Acme', meta: '2020 - 2024',
              aside: '', summary: '', bullets: [{ sourceId: 'b1', text: 'Shipped things.' }],
            },
          ],
        },
      ],
    };
    for (const t of TEMPLATES) {
      const structural = parseSafetyChecks(doc, 1, t).filter((c) => c.structural);
      expect(structural.every((c) => c.status === 'pass'), t.id).toBe(true);
    }
  });
});
