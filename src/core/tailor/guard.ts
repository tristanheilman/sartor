import { tokenize, buildLexicon, isGrounded, type Token } from './lexicon';
import { isCommonSentenceOpener, CALENDAR_WORDS, GENERIC_TERMS } from './stopwords';
import type { Profile } from '../schema';

/**
 * The fabrication guard.
 *
 * The model may reorder, reweight, re-emphasise and rephrase. It may never
 * introduce a skill, employer, date, title, technology or metric that is not in
 * the master profile. This module enforces that structurally, by checking that
 * every proper noun and every numeric token in the generated text is grounded
 * in the profile.
 *
 * The guard is deliberately conservative about *what* it flags and deliberately
 * loud about *how*. A violation is never silently dropped and never silently
 * accepted: it is surfaced to the user, who must either reject the change or
 * explicitly vouch for the fact.
 */

export type Severity = 'high' | 'medium';

export interface Violation {
  id: string;
  /** The token as it appeared in the generated text. */
  token: string;
  /** Normalised form used for the lookup. */
  norm: string;
  kind: 'number' | 'proper-noun' | 'unverified-capital';
  severity: Severity;
  /** Character offset within the checked text. */
  index: number;
  /** Human-readable explanation, shown directly in the UI. */
  message: string;
}

export interface GuardReport {
  violations: Violation[];
  /** Tokens checked, for transparency in the UI. */
  checkedTokens: number;
}

/** Has an internal capital (`GitHub`), or is an acronym (`AWS`, `SQL`). */
function hasProperNounShape(raw: string): boolean {
  const letters = raw.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  const allCaps = letters === letters.toUpperCase();
  if (allCaps) return true;
  // Internal capital after the first character, e.g. GitHub, PostgreSQL, macOS.
  return /[A-Z]/.test(raw.slice(1));
}

function startsUpper(raw: string): boolean {
  return /^[A-Z]/.test(raw);
}

function hasDigit(raw: string): boolean {
  return /[0-9]/.test(raw);
}

function classify(t: Token, lexicon: Set<string>, idFor: (t: Token) => string): Violation | null {
  if (isGrounded(t.norm, lexicon)) return null;
  if (CALENDAR_WORDS.has(t.norm) || GENERIC_TERMS.has(t.norm)) return null;

  // Numbers. Any ungrounded numeric token is a fabricated metric, date, or
  // scale claim — the highest-consequence failure mode there is.
  if (hasDigit(t.raw)) {
    // Bare single digits inside prose ("one of three") are usually spelled out;
    // a digit token that is not in the profile is still worth surfacing.
    return {
      id: idFor(t),
      token: t.raw,
      norm: t.norm,
      kind: 'number',
      severity: 'high',
      index: t.index,
      message: `The number "${t.raw}" does not appear anywhere in your master profile.`,
    };
  }

  // Proper nouns by shape — checked regardless of sentence position.
  if (hasProperNounShape(t.raw)) {
    return {
      id: idFor(t),
      token: t.raw,
      norm: t.norm,
      kind: 'proper-noun',
      severity: 'high',
      index: t.index,
      message: `"${t.raw}" looks like a name, product, or technology, and it does not appear in your master profile.`,
    };
  }

  // Capitalised mid-sentence: almost always a proper noun.
  if (startsUpper(t.raw) && !t.sentenceStart) {
    return {
      id: idFor(t),
      token: t.raw,
      norm: t.norm,
      kind: 'proper-noun',
      severity: 'high',
      index: t.index,
      message: `"${t.raw}" is capitalised mid-sentence but does not appear in your master profile.`,
    };
  }

  // Capitalised at the start of a sentence and not an ordinary English opener.
  // Genuinely ambiguous — a rephrased verb and a fabricated employer are
  // indistinguishable here — so it is flagged at lower severity.
  if (startsUpper(t.raw) && t.sentenceStart && !isCommonSentenceOpener(t.norm)) {
    return {
      id: idFor(t),
      token: t.raw,
      norm: t.norm,
      kind: 'unverified-capital',
      severity: 'medium',
      index: t.index,
      message: `"${t.raw}" opens a line and is not a word we recognise as ordinary English. If it is a company, tool, or product name, it is not in your master profile.`,
    };
  }

  return null;
}

/**
 * Checks one piece of generated text against a lexicon built from the profile.
 * `scope` is used to namespace violation IDs so they stay stable per change.
 */
export function checkText(text: string, lexicon: Set<string>, scope = 'text'): GuardReport {
  const tokens = tokenize(text);
  const violations: Violation[] = [];
  const seen = new Set<string>();

  for (const t of tokens) {
    const v = classify(t, lexicon, (tok) => `${scope}:${tok.norm}:${tok.index}`);
    if (!v) continue;
    // One violation per distinct token per scope — repeating the same warning
    // five times for five occurrences is noise, not information.
    const dedupeKey = `${scope}:${v.norm}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    violations.push(v);
  }

  return { violations, checkedTokens: tokens.length };
}

/** Builds the lexicon once per profile; reuse it across every change. */
export function profileLexicon(profile: Profile): Set<string> {
  return buildLexicon(profile);
}

/**
 * Convenience for callers that have a whole document: returns every violation
 * across a set of labelled text fragments.
 */
export function checkFragments(
  fragments: Array<{ scope: string; text: string }>,
  lexicon: Set<string>,
): Violation[] {
  return fragments.flatMap((f) => checkText(f.text, lexicon, f.scope).violations);
}

export function hasBlockingViolations(
  violations: Violation[],
  acknowledged: ReadonlySet<string>,
): boolean {
  return violations.some((v) => !acknowledged.has(v.id));
}
