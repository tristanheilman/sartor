import type { Profile } from '../schema';
import { buildDocument, type Change } from './apply';
import { checkText, profileLexicon } from './guard';
import { buildLexicon, collectStrings, equivalentForms, isGrounded } from './lexicon';
import type { TailorPlan } from './plan';

export interface UnsupportedTerm {
  /** As the summary writes it. */
  term: string;
  /**
   * Accepted changes whose rejection would put something back on the page
   * that shows it — the bullet, entry or skill keywords that were cut. Empty
   * when nothing in the profile but its own summary says it.
   */
  restoredBy: string[];
}

/**
 * Acronyms that name a kind of thing rather than a particular one. "Bridging
 * native iOS APIs" describes the work; there is no evidence of "APIs" for a
 * reader to look for. The guard still holds them to the profile.
 */
const KINDS_OF_THING = new Set(['api', 'sdk', 'ui', 'ux', 'gui', 'cli', 'ide', 'os']);

/** "8 years", "10+ yrs": vouched for by the dates on the page, not by a token. */
const YEARS_AFTER_RE = /^\+?\s*(?:years?|yrs?)\b/i;

/**
 * Names and numbers in the summary that nothing else on the page shows.
 *
 * The summary is written with the whole profile in view, and nothing checked
 * it again once the selection was made. When the fit cuts the one bullet that
 * showed a number or a technology — or the plan itself left out the role or
 * the skills that did — the summary still claims it, and a reader looking for
 * the evidence finds none. Nothing is fabricated — the guard has already
 * checked the summary against the profile — but the page no longer backs what
 * it says.
 *
 * Only terms the profile does contain are reported. One it does not is the
 * guard's business, and is already blocking the export. Words that open a
 * sentence and merely look unusual are left out too: the guard flags them
 * because a made-up employer and a rephrased verb look the same there, and on
 * this question that is noise.
 */
export function unsupportedSummaryTerms(profile: Profile, plan: TailorPlan, changes: Change[]): UnsupportedTerm[] {
  const doc = buildDocument(profile, plan, changes);
  const summary = doc.sections.find((s) => s.kind === 'summary')?.summary ?? '';
  if (!summary.trim()) return [];

  // Everything else the page prints, dates and locations included: "since
  // 2016" is shown by a start date.
  const page = buildLexicon({ ...doc, sections: doc.sections.filter((s) => s.kind !== 'summary') });
  const known = profileLexicon(profile);

  return checkText(summary, page, 'summary-support')
    .violations.filter((v) => v.kind !== 'unverified-capital')
    .filter((v) => isGrounded(v.norm, known))
    .filter((v) => !equivalentForms(v.norm).some((f) => KINDS_OF_THING.has(f)))
    .filter((v) => !(v.kind === 'number' && YEARS_AFTER_RE.test(summary.slice(v.index + v.token.length))))
    .map((v) => ({
      // "40%" reads as the claim it is; the tokeniser keeps only the 40.
      term: summary[v.index + v.token.length] === '%' ? `${v.token}%` : v.token,
      restoredBy: changes
        .filter((c) => c.status === 'accepted' && isGrounded(v.norm, buildLexicon(removedBy(c, profile))))
        .map((c) => c.id),
    }));
}

/** The text a change takes off the page, which rejecting it would put back. */
function removedBy(change: Change, profile: Profile): string[] {
  switch (change.kind) {
    case 'bullet-drop':
      return [change.before];
    case 'entry-drop': {
      const entry = [...profile.work, ...profile.projects, ...profile.education].find((e) => e.id === change.sourceId);
      return entry ? collectStrings(entry) : [];
    }
    case 'skills': {
      const kept = new Set(change.after.split(', '));
      return change.before.split(', ').filter((k) => !kept.has(k));
    }
    default:
      return [];
  }
}
