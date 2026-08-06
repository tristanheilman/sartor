import { SECTION_HEADINGS } from './model';
import type { ResumeDocument } from './model';
import { estimateHeight, pageHeight, type PageMetrics as HeightMetrics } from './model';

/** The subset of a template that decides how much text fits on a page. */
export type PageMetrics = HeightMetrics;

/**
 * The densest built-in template, as a threshold rather than a name.
 *
 * Compact's own metrics, inlined so this module does not import the template
 * registry — which pulls in zod, for a check that is otherwise arithmetic.
 */
const DENSEST: PageMetrics = {
  baseSize: 9.5,
  lineHeight: 1.28,
  pageMargin: 32,
  sectionGap: 8,
  entryGap: 6,
  bulletGap: 2,
  headingRule: false,
  bodyFont: 'Helvetica',
  headingFont: 'Helvetica-Bold',
};

/**
 * The parse-safety checklist.
 *
 * This is the replacement for a fake ATS score. Every item is a specific,
 * checkable property of the document we just produced — not a guess about how
 * some unnamed system will grade it. Items that are guaranteed by the renderer
 * say so and explain why they matter; items that depend on the user's content
 * are actually computed.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface ParseCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** True when the renderer guarantees this outcome regardless of content. */
  structural: boolean;
}

export function parseSafetyChecks(
  doc: ResumeDocument,
  /**
   * `null` when the document is not meant to fit a page count — the master
   * profile is deliberately long, and telling someone their superset does not
   * fit on one page reports the intent as a defect.
   */
  pageTarget: 1 | 2 | null,
  template?: PageMetrics,
): ParseCheck[] {
  const checks: ParseCheck[] = [
    {
      id: 'single-column',
      label: 'Single-column layout',
      status: 'pass',
      structural: true,
      detail: 'Every template renders one column. Multi-column layouts interleave text when extracted.',
    },
    {
      id: 'real-text',
      label: 'Real, selectable text',
      status: 'pass',
      structural: true,
      detail: 'Text is drawn as text, not as an image. Nothing here requires OCR to read.',
    },
    {
      id: 'no-tables',
      label: 'No tables or text boxes',
      status: 'pass',
      structural: true,
      detail: 'Dates align via tab stops, not table cells. Table structure is a common cause of scrambled output.',
    },
  ];

  const nonStandard = doc.sections.filter(
    (s) => s.heading !== SECTION_HEADINGS[s.key],
  );
  checks.push({
    id: 'standard-headings',
    label: 'Standard section headings',
    status: nonStandard.length === 0 ? 'pass' : 'warn',
    structural: false,
    detail:
      nonStandard.length === 0
        ? `Uses conventional headings: ${doc.sections.map((s) => s.heading).join(', ')}.`
        : `Non-standard headings: ${nonStandard.map((s) => s.heading).join(', ')}.`,
  });

  const hasContact = doc.contact.details.length > 0;
  const hasEmail = doc.contact.details.some((d) => d.includes('@'));
  checks.push({
    id: 'contact-in-body',
    label: 'Contact details in the document body',
    status: hasContact && hasEmail ? 'pass' : hasContact ? 'warn' : 'fail',
    structural: false,
    detail: hasEmail
      ? 'Name and contact details are body text on page one, not in a page header where extractors often drop them.'
      : hasContact
        ? 'No email address found. Most systems key on the email address specifically.'
        : 'No contact details found. Add at least an email address to your profile.',
  });

  const hasName = doc.contact.name.trim().length > 0;
  checks.push({
    id: 'name-present',
    label: 'Name present',
    status: hasName ? 'pass' : 'fail',
    structural: false,
    detail: hasName ? `Reads as "${doc.contact.name}".` : 'Your profile has no name set.',
  });

  if (pageTarget !== null) {
  const metrics = template ?? DENSEST;
  const estPages = Math.max(1, Math.ceil(estimateHeight(doc, metrics) / pageHeight(metrics)));
  // Only suggest a denser template when there is one to move to. Telling
  // someone on Compact to switch to Compact is the bug this replaced.
  const alreadyDense = template ? pageHeight(template) / (template.baseSize * template.lineHeight) >= pageHeight(DENSEST) / (DENSEST.baseSize * DENSEST.lineHeight) : false;
  checks.push({
    id: 'length',
    label: `Fits the ${pageTarget}-page target`,
    status: estPages <= pageTarget ? 'pass' : 'warn',
    structural: false,
    detail:
      estPages <= pageTarget
        ? `Estimated ${estPages} page(s).`
        : `Estimated ${estPages} page(s) against a ${pageTarget}-page target. Reject a few kept bullets${
            alreadyDense ? '' : ', or switch to the Compact template'
          }.`,
  });
  }

  const emptySections = doc.sections.filter(
    (s) =>
      (s.kind === 'entries' && (s.entries?.length ?? 0) === 0) ||
      (s.kind === 'skills' && (s.skills?.length ?? 0) === 0) ||
      (s.kind === 'list' && (s.items?.length ?? 0) === 0),
  );
  checks.push({
    id: 'no-empty-sections',
    label: 'No empty sections',
    status: emptySections.length === 0 ? 'pass' : 'warn',
    structural: false,
    detail:
      emptySections.length === 0
        ? 'Every heading has content underneath it.'
        : `Empty: ${emptySections.map((s) => s.heading).join(', ')}.`,
  });

  return checks;
}

export function worstStatus(checks: ParseCheck[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'pass';
}
