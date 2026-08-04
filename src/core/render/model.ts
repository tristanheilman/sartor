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
