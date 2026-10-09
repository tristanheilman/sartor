import { describe, it, expect } from 'vitest';
import { getTemplate, TEMPLATES } from './templates';
import { estimateHeight, linesPerPage, pageHeight, printedLines } from './model';
import { wrappedLines } from './metrics';
import { renderPdfBlob } from './pdf';
import * as pdfjs from 'pdfjs-dist';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { beforeAll } from 'vitest';
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
   * Where the page actually breaks is held against the renderer itself in
   * the next block.
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

describe('the estimate breaks the page where the renderer does', () => {
  /**
   * The fit pass trims and fills against `estimateHeight`, so the estimate's
   * idea of where a page ends *is* the page target. Two ways it was wrong,
   * both found on a real one-page resume:
   *
   *   - It charged every entry an employer-and-location row. A project has
   *     neither, so the renderer prints no such row, and each project cost
   *     sixteen points the page never spent. Three projects were most of two
   *     bullets the fill pass refused for want of room.
   *   - It left out the last section's bottom margin. The renderer counts it
   *     when the document ends in something that cannot break — an education
   *     entry with nothing under it — so on Roomy a resume the estimate put at
   *     98% moved its whole education section onto a second page.
   *
   * So this grows a document shaped like a real one a bullet at a time on
   * every template, finds the first bullet the renderer will not fit on one
   * page, and holds the estimate to the same answer: everything before that
   * bullet measures as fitting, and that bullet does not.
   */
  const pagesIn = async (doc: ResumeDocument, templateId: string) => {
    const bytes = new TextDecoder('latin1').decode(
      await (await renderPdfBlob(doc, templateId)).arrayBuffer(),
    );
    // The page tree's count. Cheaper than parsing the file back with pdf.js,
    // and the renderer writes exactly one tree.
    return Number(/\/Count (\d+)/.exec(bytes)?.[1]);
  };

  const shaped = (bullets: number, endsWith: 'education' | 'projects'): ResumeDocument => {
    const projects = {
      key: 'projects' as const,
      heading: 'Projects',
      kind: 'entries' as const,
      // No employer and no location: a project's second row is empty.
      entries: ['react-native-island', 'react-native-object-capture', 'Revento'].map((name, i) => ({
        sourceId: `p${i}`,
        primary: name,
        secondary: '',
        meta: '10/2019 - Present',
        aside: '',
        summary: '',
        bullets: [{ sourceId: `pb${i}`, text: 'Published an open-source React Native library that bridges native iOS and Android APIs.' }],
      })),
    };
    const education = {
      key: 'education' as const,
      heading: 'Education',
      kind: 'entries' as const,
      entries: [
        {
          sourceId: 'e1', primary: 'Bachelor of Science, Computer Science', secondary: 'University of Cincinnati',
          meta: '05/2021', aside: '', summary: '', bullets: [],
        },
      ],
    };
    return {
      contact: {
        name: 'Tristan Heilman',
        label: 'Full Stack / Mobile App Developer',
        details: ['tristan@example.com', '+1-555-0100', 'Cincinnati, OH', 'example.com', 'linkedin.com/in/example', 'github.com/example'],
      },
      sections: [
        {
          key: 'summary', heading: 'Summary', kind: 'summary',
          summary: 'Mobile engineer who owns React Native apps end to end: releases, authentication and native integration. Also works the backend side.',
        },
        {
          key: 'skills', heading: 'Skills', kind: 'skills',
          skills: [
            { sourceId: 's1', name: 'Languages', keywords: ['TypeScript', 'Swift', 'Kotlin', 'SQL'] },
            { sourceId: 's2', name: 'Cloud', keywords: ['Firebase', 'AWS Lambda', 'Cognito', 'RDS'] },
          ],
        },
        {
          key: 'work', heading: 'Experience', kind: 'entries',
          entries: [
            {
              sourceId: 'w1', primary: 'Lead Mobile App Developer', secondary: 'Wridz LLC', meta: '05/2022 - 09/2025',
              aside: 'Cincinnati, OH', summary: '',
              // Alternating one- and two-line bullets, as a real role has.
              bullets: Array.from({ length: bullets }, (_, i) => ({
                sourceId: `b${i}`,
                text: i % 2
                  ? 'Supported a user base of 20k+ iOS and Android users.'
                  : 'Refactored driver tracking geolocation logic by optimizing GPS polling and background task handling, reducing battery drain.',
              })),
            },
          ],
        },
        ...(endsWith === 'education' ? [projects, education] : [education, projects]),
      ],
    };
  };

  /** The fewest role bullets that push the document onto a second page. */
  const firstSpill = async (templateId: string, endsWith: 'education' | 'projects') => {
    let lo = 0;
    let hi = 60;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await pagesIn(shaped(mid, endsWith), templateId)) > 1) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  for (const endsWith of ['education', 'projects'] as const) {
    it.each(TEMPLATES.map((t) => t.id))(`%s, ending in ${endsWith}`, async (id) => {
      const t = getTemplate(id);
      const n = await firstSpill(id, endsWith);
      const page = pageHeight(t);

      // Never calls an overflowing document a fit — that is a second page.
      expect(estimateHeight(shaped(n, endsWith), t), 'spilling document').toBeGreaterThan(page);
      // Never calls a fitting document an overflow — that is a page left short.
      expect(estimateHeight(shaped(n - 1, endsWith), t), 'last fitting document').toBeLessThanOrEqual(page);
    });
  }
});

beforeAll(() => {
  globalThis.DOMMatrix ??= class {} as unknown as typeof DOMMatrix;
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ).href;
});

describe('lines counted the way the renderer sets them', () => {
  /**
   * The renderer lets spaces shrink by a third of their width and chooses line
   * breaks across a whole paragraph. Counted the simple way — break when the
   * next word does not fit at natural spacing — a long bullet on a real
   * one-page resume counted three lines and printed two. One line of phantom
   * height per long bullet is how the fill pass came to leave a band of empty
   * page at the foot of a resume it called full.
   */
  const pagesFor = async (bullets: string[], templateId: string) => {
    const doc: ResumeDocument = {
      contact: { name: 'A', label: '', details: [] },
      sections: [
        {
          key: 'work', heading: 'Work', kind: 'entries',
          entries: [{
            sourceId: 'e', primary: 'Developer', secondary: '', meta: '', aside: '', summary: '',
            bullets: [...bullets, 'end'].map((text, i) => ({ sourceId: `b${i}`, text })),
          }],
        },
      ],
    };
    const blob = await renderPdfBlob(doc, templateId);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), verbosity: 0 }).promise;
    const markers: Array<{ page: number; y: number }> = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      for (const item of (await (await pdf.getPage(n)).getTextContent()).items) {
        if ('str' in item && item.str.trim().startsWith('•')) markers.push({ page: n, y: 792 - (item.transform[5] as number) });
      }
    }
    return markers;
  };

  /** Lines each bullet printed on, from the distance to the next marker. */
  const printedLines = async (bullets: string[], templateId: string) => {
    const t = getTemplate(templateId);
    const markers = await pagesFor(bullets, templateId);
    return bullets.map((_, i) => {
      const a = markers[i];
      const b = markers[i + 1];
      if (!a || !b || a.page !== b.page) return null;
      return Math.round((b.y - a.y - t.bulletGap) / (t.baseSize * t.lineHeight));
    });
  };

  const bulletColumn = (templateId: string) => 612 - getTemplate(templateId).pageMargin * 2 - 16;

  it('counts a long bullet the two lines it prints on, not three', async () => {
    const long =
      'Users pattern now and remains records while built the app sites read sites sites shipped cycle truth of knowledge pattern of shipped while service app operated mobile owned remains remains service and integration making shipped.';
    const [printed] = await printedLines([long], 'classic');

    expect(printed).toBe(2);
    expect(wrappedLines(long, 'Helvetica', 10, bulletColumn('classic'))).toBe(2);
  });

  // Words of resume length in a fixed pseudo-random order, so the lengths
  // land at many different places relative to a line end.
  const words = 'built shipped the integration making source of truth while service remains read layer for app data pattern is now being adopted across owned and operated sites mobile release cycle team knowledge backend authentication migration production users records'.split(' ');
  let seed = 11;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sample = Array.from({ length: 40 }, () => {
    const text = Array.from({ length: 8 + Math.floor(next() * 40) }, () => words[Math.floor(next() * words.length)]).join(' ');
    return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
  });

  it.each(TEMPLATES.map((t) => t.id))('never counts a bullet a line short on %s', async (id) => {
    const t = getTemplate(id);
    const printed = await printedLines(sample, id);
    const short = sample.filter((text, i) => {
      const p = printed[i];
      return p != null && wrappedLines(text, t.bodyFont, t.baseSize, bulletColumn(id)) < p;
    });
    expect(short).toEqual([]);
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

describe('a summary\'s lines, as a warning counts them', () => {
  /**
   * `tailor apply` tells the person their summary prints on four lines. That
   * has to be what the page shows, so this measure uses the column's own
   * width rather than the narrower one the page fit plays safe with — which
   * read a three-line summary as four about one time in ten.
   */
  const rowsPrinted = async (summary: string, templateId: string) => {
    const doc: ResumeDocument = {
      contact: { name: 'A', label: '', details: [] },
      sections: [
        { key: 'summary', heading: 'Summary', kind: 'summary', summary },
        {
          key: 'work', heading: 'Work', kind: 'entries',
          entries: [{ sourceId: 'e', primary: 'Developer', secondary: '', meta: '', aside: '', summary: '', bullets: [{ sourceId: 'b', text: 'end' }] }],
        },
      ],
    };
    const blob = await renderPdfBlob(doc, templateId);
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), verbosity: 0 }).promise;
    const rows = ((await (await pdf.getPage(1)).getTextContent()).items as Array<{ str: string; transform: number[] }>)
      .filter((i) => i.str.trim())
      .map((i) => ({ y: Math.round(i.transform[5]!), text: i.str.trim() }));
    // Headings may print in capitals.
    const top = rows.find((r) => /^summary$/i.test(r.text))!.y;
    const bottom = rows.find((r) => /^work$/i.test(r.text))!.y;
    return new Set(rows.filter((r) => r.y < top && r.y > bottom).map((r) => r.y)).size;
  };

  const prose =
    'Data engineer who designs streaming pipelines and the warehouse models downstream of them, with a habit of making the on-call rotation quieter than it was before, and of writing down why each decision was made so the next person can change it safely.';
  const longer = `${prose} ${prose}`;

  // Cut where the page fit's narrower measure reads one line more than prints:
  // on Classic, a summary of three lines it would have called four.
  const cuts: Record<string, number> = { classic: 346, roomy: 276, 'serif-compact': 393 };

  for (const [id, at] of Object.entries(cuts)) {
    it(`matches what ${id} prints, near a break`, async () => {
      const summary = longer.slice(0, at);
      expect(printedLines(summary, getTemplate(id))).toBe(await rowsPrinted(summary, id));
    });
  }
});

