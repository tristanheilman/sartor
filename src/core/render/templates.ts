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
 */

export interface Template {
  id: string;
  label: string;
  description: string;
  /** PDF core font — all three are embedded by default, so nothing is fetched
   * at render time and the output works offline. */
  bodyFont: 'Helvetica' | 'Times-Roman';
  headingFont: 'Helvetica-Bold' | 'Times-Bold';
  /** DOCX equivalent. */
  docxFont: string;
  baseSize: number;
  lineHeight: number;
  sectionGap: number;
  entryGap: number;
  bulletGap: number;
  uppercaseHeadings: boolean;
  headingRule: boolean;
  pageMargin: number;
}

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
];

export function getTemplate(id: string): Template {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0]!;
}
