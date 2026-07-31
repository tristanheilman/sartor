import { tokenize, buildLexicon, isGrounded } from './lexicon';
import { SENTENCE_START_ALLOWLIST, GENERIC_TERMS, CALENDAR_WORDS } from './stopwords';
import type { Profile } from '../schema';

/**
 * Honest coverage signals.
 *
 * This module deliberately does **not** produce a score. The widely-repeated
 * claim that ATS software auto-rejects 75% of resumes is fabricated — it traces
 * back to vendor marketing, not research — and in practice only a small
 * minority of employers configure content-based automatic rejection at all.
 * A 0-100 number would therefore be inventing precision that does not exist,
 * and would push users toward keyword stuffing, which is worse for the human
 * who eventually reads the document.
 *
 * What we can say honestly is checkable:
 *
 *   - which terms from the posting appear in the tailored resume, and where;
 *   - which terms are in the master profile but did not make it into this
 *     version (recoverable — the user can pull them in);
 *   - which terms appear nowhere in the master profile (a genuine gap, not a
 *     formatting problem, and not something the tool should paper over).
 */

export type TermStatus = 'present' | 'in-profile' | 'missing';

export interface CoverageTerm {
  term: string;
  norm: string;
  /** How often the posting mentions it. A rough proxy for how much it matters. */
  mentions: number;
  /** True if the posting phrased it as a hard requirement. */
  emphasised: boolean;
  status: TermStatus;
  /** Where it appears in the tailored resume, e.g. "Experience · Acme Robotics". */
  locations: string[];
}

export interface CoverageReport {
  terms: CoverageTerm[];
  present: CoverageTerm[];
  inProfileOnly: CoverageTerm[];
  missing: CoverageTerm[];
}

/** Phrases that mark what follows as a stated requirement. */
const CUE_RE =
  /\b(?:experience (?:with|in|using)|proficien(?:t|cy) (?:with|in)|knowledge of|familiar(?:ity)? with|expertise in|background in|skilled in|working with|must have|required|requirements?|you (?:will )?(?:have|need)|strong)\b/gi;

/** Words that never constitute a "requirement" on their own. */
const NOISE = new Set([
  ...SENTENCE_START_ALLOWLIST,
  ...GENERIC_TERMS,
  ...CALENDAR_WORDS,
  'we',
  'you',
  'your',
  'our',
  'us',
  'job',
  'role',
  'work',
  'working',
  'candidate',
  'candidates',
  'applicant',
  'apply',
  'ability',
  'abilities',
  'excellent',
  'strong',
  'great',
  'good',
  'plus',
  'nice',
  'bonus',
  'preferred',
  'required',
  'requirements',
  'requirement',
  'years',
  'year',
  'yrs',
  'etc',
  'including',
  'include',
  'includes',
  'such',
  'well',
  'help',
  'like',
  'across',
  'benefits',
  'salary',
  'compensation',
  'equity',
  'remote',
  'hybrid',
  'onsite',
  'full',
  'time',
  'senior',
  'junior',
  'staff',
  'lead',
  'engineer',
  'engineering',
  'developer',
  'manager',
  'company',
  'companies',
  'business',
  'product',
  'products',
  'customer',
  'customers',
  'user',
  'users',
  'partner',
  'partners',
  'stakeholder',
  'stakeholders',
  // Job-posting boilerplate nouns. These frequently open a sentence and are
  // therefore capitalised ("Familiarity with Terraform is required"), which
  // would otherwise make them look like named technologies.
  'familiarity',
  'proficiency',
  'proficient',
  'knowledge',
  'expertise',
  'background',
  'exposure',
  'understanding',
  'experienced',
  'passion',
  'willingness',
  'track',
  'record',
  'must',
  'should',
  'ideally',
  'ideal',
  'minimum',
  'degree',
  'equivalent',
  'related',
  'field',
  'industry',
  'environment',
  'environments',
  'tools',
  'technologies',
  'systems',
  'solutions',
  'practices',
  'processes',
  'standards',
  'quality',
  'performance',
  'scale',
  'scalable',
  'growth',
  'impact',
  'ownership',
  'collaboration',
  'communication',
  'leadership',
  'mentorship',
  'responsibilities',
  'qualifications',
  'duties',
  'overview',
  'description',
  'about',
  'department',
  'nice',
  'must-have',
]);

/**
 * Is this token plausibly a named skill, tool, or technology?
 *
 * Shape alone is not enough. `PostgreSQL`, `gRPC`, and `AWS` announce
 * themselves through an internal capital or all-caps, but `Kubernetes`,
 * `Terraform`, `Django`, and `Kafka` are ordinary capitalised words — and they
 * are just as much requirements. Relying on shape meant those were only picked
 * up when they happened to sit near a phrase like "experience with", which is
 * luck, not detection.
 *
 * So any capitalised token that is not ordinary English and not boilerplate
 * counts. `NOISE` carries the weight here: it includes the common-word and
 * imperative-verb lists, which is what keeps "Design", "Build", and "We" out.
 */
function looksLikeSkill(raw: string, norm: string): boolean {
  if (NOISE.has(norm)) return false;
  if (norm.length < 2) return false;

  // Acronyms, internal capitals, versioned or punctuated tech names.
  const letters = raw.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return true;
  if (/[A-Z]/.test(raw.slice(1))) return true;
  if (/[.+#/]/.test(raw) && /[A-Za-z]/.test(raw)) return true;

  // A plain capitalised word that survived the noise filter.
  if (/^[A-Z]/.test(raw)) return true;

  return false;
}

/**
 * Pulls candidate requirement terms out of a job posting.
 *
 * This is a heuristic and is presented as one in the UI. It favours precision
 * over recall: a term we surface should be one a human would agree the posting
 * asked for.
 */
export function extractRequirements(jdText: string, limit = 40): Array<{
  term: string;
  norm: string;
  mentions: number;
  emphasised: boolean;
}> {
  const tokens = tokenize(jdText);
  const counts = new Map<string, { term: string; mentions: number; emphasised: boolean }>();

  // Character ranges that sit shortly after a requirement cue.
  const cueWindows: Array<[number, number]> = [];
  for (const m of jdText.matchAll(CUE_RE)) {
    const start = m.index + m[0].length;
    cueWindows.push([start, start + 90]);
  }
  const inCueWindow = (i: number) => cueWindows.some(([a, b]) => i >= a && i <= b);

  for (const t of tokens) {
    const emphasised = inCueWindow(t.index);
    // A term qualifies either by shape, or by being a capitalised word sitting
    // inside a requirement clause. The capitalisation test is what keeps the
    // cue-window path precise: it admits short tech names that have no
    // distinguishing shape (Go, R, Vue) without dragging in the surrounding
    // prose ("experience", "daily", "exposure").
    const inRequirementClause =
      emphasised && !NOISE.has(t.norm) && t.norm.length >= 2 && /^[A-Z]/.test(t.raw);
    if (!looksLikeSkill(t.raw, t.norm) && !inRequirementClause) continue;
    const existing = counts.get(t.norm);
    if (existing) {
      existing.mentions += 1;
      existing.emphasised ||= emphasised;
    } else {
      counts.set(t.norm, { term: t.raw, mentions: 1, emphasised });
    }
  }

  return [...counts.entries()]
    .map(([norm, v]) => ({ norm, ...v }))
    .sort(
      (a, b) =>
        Number(b.emphasised) - Number(a.emphasised) ||
        b.mentions - a.mentions ||
        a.term.localeCompare(b.term),
    )
    .slice(0, limit);
}

export interface ResumeSlice {
  /** Human-readable location, e.g. "Experience · Senior Engineer, Acme". */
  label: string;
  text: string;
}

/**
 * Classifies each posting term against the tailored resume and the master
 * profile. `missing` means the user genuinely does not have it — the tool will
 * not manufacture it, and says so plainly.
 */
export function buildCoverage(
  jdText: string,
  resumeSlices: ResumeSlice[],
  profile: Profile,
): CoverageReport {
  const requirements = extractRequirements(jdText);
  const profileLex = buildLexicon(profile);

  const sliceLexicons = resumeSlices.map((s) => ({
    label: s.label,
    lex: buildLexicon(s.text),
  }));

  const terms: CoverageTerm[] = requirements.map((r) => {
    const locations = sliceLexicons.filter((s) => isGrounded(r.norm, s.lex)).map((s) => s.label);
    const inProfile = isGrounded(r.norm, profileLex);
    const status: TermStatus =
      locations.length > 0 ? 'present' : inProfile ? 'in-profile' : 'missing';
    return { term: r.term, norm: r.norm, mentions: r.mentions, emphasised: r.emphasised, status, locations };
  });

  return {
    terms,
    present: terms.filter((t) => t.status === 'present'),
    inProfileOnly: terms.filter((t) => t.status === 'in-profile'),
    missing: terms.filter((t) => t.status === 'missing'),
  };
}
