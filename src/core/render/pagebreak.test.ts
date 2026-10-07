import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist';
import { renderPdfBlob } from './pdf';
import { getTemplate, TEMPLATES } from './templates';
import type { ResumeDocument } from './model';

/**
 * Where the renderer breaks a page.
 *
 * A two-page export on Classic ended page one with a bullet marker and nothing
 * beside it; the bullet's text opened page two with no marker at all. Looking
 * across every template turned up two more failures of the same kind:
 *
 *   - A role's title and employer at the foot of a page, every bullet under it
 *     overleaf. The guard against that never ran: @react-pdf only honours
 *     `minPresenceAhead` on an element with an earlier sibling in its own
 *     container, and a heading is always the first.
 *   - Half a page left empty. @react-pdf moves an element whose content fits
 *     but whose bottom margin does not, whole — so a role with eleven bullets
 *     went to page two over less than a point of margin, and the export ran to
 *     three pages against a target of two.
 *
 * Every case here is checked on the rendered file, because each of them is
 * the renderer's behaviour rather than ours, and nothing short of rendering
 * shows it. The documents are swept so that the page boundary falls at many
 * different places in them, on every template.
 */

const pdfWorkerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

beforeAll(() => {
  globalThis.DOMMatrix ??= class {} as unknown as typeof DOMMatrix;
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
});

interface Line {
  /** Distance from the top of the page to the baseline, in points. */
  y: number;
  text: string;
}

/** Each page as its lines, top to bottom. */
async function pagesOf(doc: ResumeDocument, templateId: string): Promise<Line[][]> {
  const blob = await renderPdfBlob(doc, templateId);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), verbosity: 0 }).promise;

  const pages: Line[][] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    // Items on one baseline are one line. A bullet's marker and its text are
    // separate items whose baselines differ by a fraction of a point.
    const rows = new Map<number, string>();
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      const y = Math.round((792 - (item.transform[5] as number)) / 2) * 2;
      rows.set(y, `${rows.get(y) ?? ''}${item.str}`);
    }
    pages.push([...rows.entries()].sort((a, b) => a[0] - b[0]).map(([y, text]) => ({ y, text })));
  }
  return pages;
}

const TWO_LINES =
  'Led anonymization of 2.8 million legacy users across PostgreSQL and Firebase, writing the scripts, provisioning the VMs and coordinating checks with the team.';
const ONE_LINE = 'Supported a user base of 20k+ iOS and Android users.';

/**
 * A two-page resume shaped like a real one, with `lead` one-line bullets on
 * the first role and a summary of `summaryLines` lines, so that across a sweep
 * the page boundary lands on bullets, titles, headings and margins in turn.
 */
function shaped(lead: number, summaryLines: 1 | 2): ResumeDocument {
  const entry = (id: string, primary: string, secondary: string, bullets: string[]) => ({
    sourceId: id,
    primary,
    secondary,
    meta: '05/2022 - 09/2025',
    aside: secondary ? 'Cincinnati, OH' : '',
    summary: '',
    bullets: bullets.map((text, i) => ({ sourceId: `${id}-${i}`, text })),
  });

  return {
    contact: {
      name: 'Tristan Heilman',
      label: 'Mobile Engineer',
      details: ['tristan@example.com', '+1-555-0100', 'Cincinnati, OH'],
    },
    sections: [
      {
        key: 'summary',
        heading: 'Summary',
        kind: 'summary',
        summary:
          summaryLines === 1
            ? 'Mobile engineer who owns React Native apps end to end.'
            : 'Mobile engineer who owns React Native apps end to end: releases, authentication and native integration, with the backend work that goes with them.',
      },
      {
        key: 'skills',
        heading: 'Skills',
        kind: 'skills',
        skills: [
          { sourceId: 's1', name: 'Languages', keywords: ['TypeScript', 'Swift', 'Kotlin', 'SQL'] },
          { sourceId: 's2', name: 'Cloud', keywords: ['Firebase', 'AWS', 'PostgreSQL'] },
        ],
      },
      {
        key: 'work',
        heading: 'Experience',
        kind: 'entries',
        entries: [
          entry('w1', 'Native App Developer', 'Formedics', Array(lead).fill(ONE_LINE)),
          entry('w2', 'Lead Mobile App Developer', 'Wridz LLC', Array(11).fill(TWO_LINES)),
          entry('w3', 'Junior Software Developer', 'CIMx Software', [ONE_LINE, TWO_LINES, ONE_LINE]),
        ],
      },
      {
        key: 'projects',
        heading: 'Projects',
        kind: 'entries',
        entries: ['react-native-island', 'react-native-object-capture', 'Revento'].map((name, i) =>
          entry(`p${i}`, name, '', [TWO_LINES, ONE_LINE]),
        ),
      },
      {
        key: 'education',
        heading: 'Education',
        kind: 'entries',
        entries: [entry('e1', 'Bachelor of Science, Computer Science', 'University of Cincinnati', [])],
      },
    ],
  };
}

const HEADINGS = ['summary', 'skills', 'experience', 'projects', 'education'];
const TITLES = [
  'Native App Developer',
  'Lead Mobile App Developer',
  'Junior Software Developer',
  'react-native-island',
  'react-native-object-capture',
  'Revento',
];

/** Bullet counts for the first role, chosen so the sweep crosses a full page's worth of offsets. */
const SWEEP = [0, 3, 6, 9, 12, 15, 18, 21];

describe.each(TEMPLATES.map((t) => t.id))('page breaks on %s', (id) => {
  const t = getTemplate(id);
  let rendered: Line[][][] = [];

  beforeAll(async () => {
    rendered = [];
    for (const lead of SWEEP) {
      for (const summaryLines of [1, 2] as const) rendered.push(await pagesOf(shaped(lead, summaryLines), id));
    }
  });

  it('never separates a bullet marker from its text', () => {
    for (const pages of rendered) {
      for (const page of pages) {
        const bare = page.filter((l) => l.text.trim() === '•');
        expect(bare, 'a marker alone on its line').toEqual([]);
      }
    }
  });

  it('never ends a page on a section heading', () => {
    for (const pages of rendered) {
      for (const page of pages.slice(0, -1)) {
        const last = page[page.length - 1]!.text.trim().toLowerCase();
        expect(HEADINGS, `page ending "${last}"`).not.toContain(last);
      }
    }
  });

  it('never ends a page on a role or project title', () => {
    for (const pages of rendered) {
      for (const page of pages.slice(0, -1)) {
        // The title row, or the employer row beneath it.
        const tail = page.slice(-2).map((l) => l.text);
        const last = page[page.length - 1]!.text;
        const endsOnTitle = TITLES.some((title) => last.includes(title)) ||
          (tail.length === 2 && TITLES.some((title) => tail[0]!.includes(title)) && !last.startsWith('•'));
        expect(endsOnTitle, `page ending "${last}"`).toBe(false);
      }
    }
  });

  it('never leaves most of a page empty to keep a role together', () => {
    // The tallest thing kept together is a heading, a title and a two-line
    // bullet — about six lines. Anything more than twice that at the foot of
    // a page that is not the last means something big was moved whole.
    const line = t.baseSize * t.lineHeight;
    const bottom = 792 - t.pageMargin;
    for (const pages of rendered) {
      for (const page of pages.slice(0, -1)) {
        const lastBaseline = page[page.length - 1]!.y;
        expect(bottom - lastBaseline, 'empty points at the foot of the page').toBeLessThan(line * 12);
      }
    }
  });
});
