/**
 * Templates.
 *
 * Every template here obeys the same hard rules, because these are the actual
 * ways a resume fails to parse — not the things resume advice usually worries
 * about:
 *
 *   - one column, always;
 *   - real selectable text, never an image of text;
 *   - standard section headings (Experience, Education, Skills);
 *   - contact details in the document body, never in a page header or footer,
 *     because header/footer content is what extractors most often drop;
 *   - no tables, no text boxes, no columns, no icons carrying meaning.
 *
 * What varies between templates is typography and density. Nothing structural
 * varies, so choosing a template can never make a document parse worse.
 *
 * That invariant is also why a user-defined template is a set of typography
 * values rather than a layout or a stylesheet. Every field below is a number, a
 * boolean, or one of a fixed set of fonts, and the bounds in `templateSchema`
 * are what keep "make your own" from becoming "make your own unparseable
 * resume". A template someone writes by hand is subject to exactly the same
 * rules as the built-in ones.
 */

import { z } from 'zod';

export const templateSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1),
  description: z.string().trim().default(''),
  /** PDF core font — both are embedded by default, so nothing is fetched at
   * render time and the output works offline. A font that has to be downloaded
   * is a font that can fail to arrive, so the set stays closed. */
  bodyFont: z.enum(['Helvetica', 'Times-Roman']),
  headingFont: z.enum(['Helvetica-Bold', 'Times-Bold']),
  /** DOCX equivalent. Restricted to fonts that ship with Word on both
   * platforms; anything else silently substitutes on the reader's machine. */
  docxFont: z.enum(['Calibri', 'Cambria', 'Arial', 'Georgia', 'Times New Roman']),
  /** Below ~8.5pt a resume stops being comfortably readable in print, and
   * above ~13pt the density claim stops being true. */
  baseSize: z.number().min(8.5).max(13),
  lineHeight: z.number().min(1.05).max(1.8),
  sectionGap: z.number().min(0).max(40),
  entryGap: z.number().min(0).max(40),
  bulletGap: z.number().min(0).max(20),
  uppercaseHeadings: z.boolean(),
  headingRule: z.boolean(),
  /** A margin under ~24pt risks being clipped by physical printers. */
  pageMargin: z.number().min(24).max(90),
});

export type Template = z.infer<typeof templateSchema>;

/** Either a built-in template's id or a full template object (a user's own). */
export type TemplateRef = string | Template;

export const TEMPLATES: Template[] = [
  {
    id: 'classic',
    label: 'Classic',
    description: 'Ruled sans-serif headings, generous spacing. A safe default.',
    bodyFont: 'Helvetica',
    headingFont: 'Helvetica-Bold',
    docxFont: 'Calibri',
    baseSize: 10,
    lineHeight: 1.4,
    sectionGap: 12,
    entryGap: 9,
    bulletGap: 3,
    uppercaseHeadings: true,
    headingRule: true,
    pageMargin: 42,
  },
  {
    id: 'compact',
    label: 'Compact',
    description: 'Tighter leading and margins. Use when one page is a hard limit.',
    bodyFont: 'Helvetica',
    headingFont: 'Helvetica-Bold',
    docxFont: 'Calibri',
    baseSize: 9.5,
    lineHeight: 1.28,
    sectionGap: 8,
    entryGap: 6,
    bulletGap: 2,
    uppercaseHeadings: true,
    headingRule: false,
    pageMargin: 32,
  },
  {
    id: 'serif',
    label: 'Serif',
    description: 'Times body text. Conventional in academia, law, and finance.',
    bodyFont: 'Times-Roman',
    headingFont: 'Times-Bold',
    docxFont: 'Cambria',
    baseSize: 10.5,
    lineHeight: 1.38,
    sectionGap: 11,
    entryGap: 8,
    bulletGap: 3,
    uppercaseHeadings: false,
    headingRule: true,
    pageMargin: 46,
  },
  {
    id: 'roomy',
    label: 'Roomy',
    description: 'Large type and wide margins. For a short resume that would otherwise look thin.',
    bodyFont: 'Helvetica',
    headingFont: 'Helvetica-Bold',
    docxFont: 'Calibri',
    baseSize: 11.5,
    lineHeight: 1.5,
    sectionGap: 16,
    entryGap: 12,
    bulletGap: 4,
    uppercaseHeadings: true,
    headingRule: true,
    pageMargin: 60,
  },
  {
    id: 'serif-compact',
    label: 'Serif Compact',
    description: 'Times at Compact density. When the convention is serif but the limit is one page.',
    bodyFont: 'Times-Roman',
    headingFont: 'Times-Bold',
    docxFont: 'Cambria',
    baseSize: 10,
    lineHeight: 1.24,
    sectionGap: 8,
    entryGap: 6,
    bulletGap: 2,
    uppercaseHeadings: true,
    headingRule: false,
    pageMargin: 34,
  },
  {
    id: 'plain',
    label: 'Plain',
    description: 'No rules, no uppercasing. The least decorated option in the set.',
    bodyFont: 'Helvetica',
    headingFont: 'Helvetica-Bold',
    docxFont: 'Arial',
    baseSize: 10,
    lineHeight: 1.36,
    sectionGap: 11,
    entryGap: 8,
    bulletGap: 3,
    uppercaseHeadings: false,
    headingRule: false,
    pageMargin: 44,
  },
];

/**
 * Resolve a template reference.
 *
 * A user's own template arrives as a whole object rather than an id, because
 * the renderers must not depend on browser storage to find it — the library is
 * usable outside the app, where IndexedDB does not exist. An unknown id falls
 * back to the first built-in rather than throwing: a template that has been
 * deleted should cost you its typography, not your export.
 */
export function getTemplate(ref: TemplateRef): Template {
  if (typeof ref !== 'string') return ref;
  return TEMPLATES.find((t) => t.id === ref) ?? TEMPLATES[0]!;
}

export function isBuiltInTemplate(id: string): boolean {
  return TEMPLATES.some((t) => t.id === id);
}
