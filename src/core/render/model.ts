import { widthOf, wrappedLines, wrappedRunLines } from './metrics';
import type { SectionKey } from '../schema';
import type { ResumeSlice } from '../tailor/coverage';

/**
 * The render model: a fully resolved, plain-data description of one tailored
 * resume.
 *
 * The LLM never produces this and never sees it. The model produces a *plan*;
 * a deterministic function turns the plan plus the master profile into this
 * structure; and the PDF and DOCX renderers turn this structure into files.
 * That separation is what stops the model from emitting markup that becomes the
 * artifact, and it is why the two output formats can never drift apart.
 */

export interface DocContact {
  name: string;
  label: string;
  /** Rendered inline in the document body — never in a header or footer,
   * because that is where text extraction most reliably fails. */
  details: string[];
}

export interface DocBullet {
  /** Source bullet id, kept so a rendered line is always traceable. */
  sourceId: string;
  text: string;
}

export interface DocEntry {
  sourceId: string;
  /** e.g. "Senior Engineer" */
  primary: string;
  /** e.g. "Acme Robotics" */
  secondary: string;
  /** e.g. "Mar 2021 — Nov 2024" */
  meta: string;
  /** e.g. "Berlin, DE" */
  aside: string;
  summary: string;
  bullets: DocBullet[];
}

export interface DocSkillGroup {
  sourceId: string;
  name: string;
  keywords: string[];
}

export interface DocSection {
  key: SectionKey;
  /** Standard, recognisable headings. Creative section names are a real
   * parse-failure mode, so the vocabulary here is deliberately boring. */
  heading: string;
  kind: 'summary' | 'entries' | 'skills' | 'list';
  summary?: string;
  entries?: DocEntry[];
  skills?: DocSkillGroup[];
  items?: Array<{ sourceId: string; text: string }>;
}

export interface ResumeDocument {
  contact: DocContact;
  sections: DocSection[];
}

export const SECTION_HEADINGS: Record<SectionKey, string> = {
  summary: 'Summary',
  skills: 'Skills',
  work: 'Experience',
  projects: 'Projects',
  education: 'Education',
  certificates: 'Certifications',
  awards: 'Awards',
};

/** Flattens a document into labelled text slices for the coverage report. */
export function documentToSlices(doc: ResumeDocument): ResumeSlice[] {
  const slices: ResumeSlice[] = [];

  for (const section of doc.sections) {
    if (section.kind === 'summary' && section.summary) {
      slices.push({ label: 'Summary', text: section.summary });
    }
    if (section.kind === 'skills' && section.skills) {
      for (const g of section.skills) {
        slices.push({ label: `Skills · ${g.name}`, text: g.keywords.join(', ') });
      }
    }
    if (section.kind === 'entries' && section.entries) {
      for (const e of section.entries) {
        const label = `${section.heading} · ${e.secondary || e.primary}`;
        const text = [e.primary, e.secondary, e.summary, ...e.bullets.map((b) => b.text)]
          .filter(Boolean)
          .join('\n');
        slices.push({ label, text });
      }
    }
    if (section.kind === 'list' && section.items) {
      for (const i of section.items) slices.push({ label: section.heading, text: i.text });
    }
  }

  return slices;
}

/** Everything in the document as one string — used for the guard sweep. */
export function documentToText(doc: ResumeDocument): string {
  return [
    doc.contact.name,
    doc.contact.label,
    ...doc.contact.details,
    ...documentToSlices(doc).map((s) => s.text),
  ].join('\n');
}

/**
 * How many lines a paragraph of body text prints on across the full column —
 * the summary, say.
 *
 * Measured at the column's own width, not the narrower one `estimateHeight`
 * uses. Reading a line long near a break is the safe side for fitting a page,
 * but this answers a question someone acts on, and "your summary prints on four
 * lines" had better be true. Against 4,095 summaries rendered in every built-in
 * template it agreed with the PDF on all but 0.7%, and never counted a line
 * short. At the narrower width, about one in ten read a line long.
 */
export function printedLines(text: string, t: PageMetrics): number {
  return wrappedLines(text, t.bodyFont ?? 'Helvetica', t.baseSize, 612 - t.pageMargin * 2);
}

/** Ordinary prose, for the width of an average character in it. */
const PROSE_SAMPLE =
  'Senior software engineer with eight years building mobile apps and the platform services behind them, most recently leading a small team that ships an app used by millions of people every week.';

/**
 * About how many characters of prose fill a line of body text.
 *
 * Characters rather than words, because only one of them is stable. Measured
 * on summaries from three unrelated fields, characters per line agreed to
 * within one percent in every template; words per line ran from 13 to 19 on
 * the same line, with the length of the vocabulary.
 */
export function charactersPerLine(t: PageMetrics): number {
  const perCharacter = widthOf(PROSE_SAMPLE, t.bodyFont ?? 'Helvetica', t.baseSize) / PROSE_SAMPLE.length;
  return (612 - t.pageMargin * 2) / perCharacter;
}

/**
 * How tall the document renders, in points, for a given template.
 *
 * `estimateLines` counts lines and charges flat constants for headings and
 * entries, which is close enough to warn on but not close enough to trim
 * against: it models neither leading nor the gaps between sections, entries
 * and bullets, all of which the template specifies in points. A document it
 * measured at exactly one page rendered as two, and the workaround — ten lines
 * of headroom — was costing a whole projects section.
 *
 * This measures what the renderer is told to do. Characters-per-line is still
 * an approximation, because the fonts are not measured, but everything else is
 * the template's own numbers.
 */
export function estimateHeight(doc: ResumeDocument, t: PageMetrics): number {
  const line = t.baseSize * t.lineHeight;
  // US Letter, less both margins. The renderer wraps to exactly this.
  const column = 612 - t.pageMargin * 2;

  const body = t.bodyFont ?? 'Helvetica';
  const heading = t.headingFont ?? 'Helvetica-Bold';

  // Widths a little inside what the renderer has, so a paragraph near a break
  // is counted a line long rather than a line short. Rendering every built-in
  // template and matching this line breaker to what came out put the
  // renderer's effective width between 9.6 and 15.1pt inside the column for a
  // bullet (the marker, its gutter, the row's padding), and no more than 9.8pt
  // inside it for full-width text. These sit inside every template's figure.
  // Short is the expensive side to be wrong on: it is a second page.
  const textColumn = column - 12;
  const bulletColumn = column - 16;

  const wrapped = (text: string, font = body, size = t.baseSize) =>
    wrappedLines(text, font, size, textColumn);

  // Name, headline, contact. The name renders at 1.9x body size with its own
  // leading; the contact line wraps like anything else.
  const nameSize = t.baseSize * 1.9;
  let header = nameSize * 1.2 + 4;
  if (doc.contact.label) header += t.baseSize * 1.05 * 1.3 + 4;
  // The page sets `lineHeight`, and @react-pdf resolves it to points before
  // passing it down: every text that does not set its own gets the body's
  // leading, whatever its size. So the contact line and the headings are
  // charged `line`, not their own size times the ratio — which read half a
  // point high per heading, enough on the tightest templates to call the
  // last bullet of a full page an overflow.
  if (doc.contact.details.length) {
    header +=
      wrappedLines(doc.contact.details.join(' · '), body, t.baseSize * 0.95, textColumn) * line +
      t.sectionGap;
  }

  // The document as the renderer lays it out: a run of blocks that a page may
  // fall between but never inside, each carrying the space below it. See
  // `sectionBlocks` in `pdf.tsx`, which this mirrors block for block.
  //
  // Each margin is charged where the renderer puts it — below the contact
  // line, below each entry's last block, below each section's — the last one
  // included. Charging a gap *above* each section instead came to the same
  // total only when there was a contact line and the last margin did not
  // matter, and it does: the renderer counts it. On Roomy those sixteen points
  // were the difference between one page and two: a resume the estimate put at
  // 98% moved its education section onto a page of its own.
  const blocks: number[] = [header];
  // Leading, the gap beneath, and where there is a rule its padding and width.
  const headingHeight = line + 4 + (t.headingRule ? 2 + 0.75 : 0);

  // The gaps charged to the last block so far, so they can be taken back off
  // the document's final one.
  let trailing = 0;
  for (const s of doc.sections) {
    const first = blocks.length;
    // The heading travels with whatever follows it, so it is charged to the
    // section's first block rather than standing alone.
    let lead = headingHeight;

    if (s.kind === 'summary' && s.summary) lead += wrapped(s.summary) * line;

    // Skills flow as one paragraph, so they are measured as one. Charging each
    // group its own line — as the renderer used to lay them out — over-counted
    // by whatever was left of each group's last line, and the trim then dropped
    // whole groups to buy back space the layout was wasting.
    const groups = s.skills ?? [];
    if (s.kind === 'skills' && groups.length) {
      // Set as the renderer sets it: bold labels, the keywords, and a spaced
      // separator between groups, broken as one paragraph.
      // The separator and the gap before it exactly as `pdf.tsx` sets them,
      // and like the renderer, never breaking between two runs.
      const runs = groups.flatMap((g, i) => [
        ...(i > 0 ? [{ text: ' ·\u00A0\u00A0\u00A0', font: body }] : []),
        { text: `${g.name}: `, font: heading },
        { text: `${g.keywords.join(', ')}${i < groups.length - 1 ? '\u00A0\u00A0' : ''}`, font: body },
      ]);
      lead += wrappedRunLines(runs, t.baseSize, textColumn, { breakBetweenRuns: false }) * line + 2;
    }

    if (s.kind === 'list') {
      (s.items ?? []).forEach((i, n) => {
        const item = wrapped(i.text) * line + 2;
        if (n === 0) lead += item;
        else blocks.push(item);
      });
      if (blocks.length === first) blocks.push(lead);
      else blocks.splice(first, 0, lead);
    } else if (s.kind === 'entries' && s.entries?.length) {
      s.entries.forEach((e, n) => {
        // Title and dates share a row; employer and location share the next —
        // when there is one. A project has neither, the renderer prints no row
        // for it, and charging one anyway cost every project sixteen points the
        // page never spent: three of them were most of two bullets the fill
        // pass refused for want of room.
        let title = (n === 0 ? lead : 0) + (e.secondary || e.aside ? line * 2 + 2 : line);
        if (e.summary) title += wrapped(e.summary) * line + 2;

        const bullets = e.bullets.map(
          (b) => wrappedLines(b.text, body, t.baseSize, bulletColumn) * line + t.bulletGap,
        );
        // The title keeps its first bullet with it.
        blocks.push(title + (bullets[0] ?? 0), ...bullets.slice(1));
        blocks[blocks.length - 1]! += t.entryGap;
        trailing = t.entryGap;
      });
    } else {
      blocks.push(lead);
    }

    blocks[blocks.length - 1]! += t.sectionGap;
    trailing = (s.kind === 'entries' && s.entries?.length ? trailing : 0) + t.sectionGap;
  }

  // The renderer drops the space below the very last block — nothing follows
  // it — so it is not charged either.
  if (doc.sections.length) blocks[blocks.length - 1]! -= trailing;

  // Laid out a page at a time. A block that does not fit in what is left of a
  // page goes whole to the next, and the space it leaves behind is spent: on a
  // two-page target, measuring the flow as though it were one long column
  // called a document two pages that rendered as three.
  const page = pageHeight(t);
  let before = 0;
  let used = 0;
  for (const h of blocks) {
    if (used > 0 && used + h > page) {
      before += page;
      used = 0;
    }
    used += h;
  }
  return before + used;
}

/** Usable height of one page, in points. */
export function pageHeight(t: PageMetrics): number {
  return 792 - t.pageMargin * 2;
}

/** The subset of a template that decides how tall things render. */
export interface PageMetrics {
  baseSize: number;
  lineHeight: number;
  pageMargin: number;
  sectionGap: number;
  entryGap: number;
  bulletGap: number;
  headingRule: boolean;
  /** Core PDF font names. Default to Helvetica when a caller omits them. */
  bodyFont?: string;
  headingFont?: string;
}

/** The default template's metrics, when the caller does not say which. */
export const DEFAULT_PAGE_METRICS: PageMetrics = {
  baseSize: 10,
  lineHeight: 1.4,
  pageMargin: 42,
  sectionGap: 12,
  entryGap: 9,
  bulletGap: 3,
  headingRule: true,
  bodyFont: 'Helvetica',
  headingFont: 'Helvetica-Bold',
};

/** Rough length estimate, used only to warn about overflow before rendering. */
export function estimateLines(doc: ResumeDocument): number {
  let lines = 4; // contact block
  for (const s of doc.sections) {
    lines += 2; // heading + spacing
    if (s.summary) lines += Math.ceil(s.summary.length / 105);
    for (const g of s.skills ?? []) lines += Math.ceil((g.name.length + g.keywords.join(', ').length) / 100);
    for (const e of s.entries ?? []) {
      lines += 2;
      if (e.summary) lines += Math.ceil(e.summary.length / 105);
      for (const b of e.bullets) lines += Math.ceil(b.text.length / 95);
    }
    lines += s.items?.length ?? 0;
  }
  return lines;
}

/**
 * Lines that comfortably fit on one page, for the template actually chosen.
 *
 * This was a single constant, which made the page-fit check give advice it
 * could not act on: it warned "estimated 2 pages — switch to the Compact
 * template", and switching changed nothing, because the estimate never looked
 * at the template. A remedy that provably does not work is worse than none.
 *
 * Templates already carry what this needs. US Letter is 792pt tall, the margin
 * is taken off top and bottom, and a line of body text occupies `baseSize x
 * lineHeight`.
 *
 * Section, entry and bullet gaps are deliberately *not* subtracted here.
 * `estimateLines` already charges two lines per section and two per entry for
 * exactly that whitespace, and taking it off both sides put Roomy at 29 lines
 * a page — tighter than a page really is, and tight enough to warn about
 * documents that fit.
 */
export function linesPerPage(template: {
  baseSize: number;
  lineHeight: number;
  pageMargin: number;
}): number {
  const PAGE_HEIGHT = 792;
  const usable = PAGE_HEIGHT - template.pageMargin * 2;
  const lineHeightPt = template.baseSize * template.lineHeight;
  return Math.max(1, Math.floor(usable / lineHeightPt));
}

/**
 * The old fixed value, kept because it is exported API.
 *
 * @deprecated Use `linesPerPage(template)`; a page depends on the template.
 */
export const LINES_PER_PAGE = 52;
