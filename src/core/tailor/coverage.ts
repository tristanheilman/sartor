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
  // Degree words. "Deep PostgreSQL knowledge" requires PostgreSQL, not Deep —
  // and with whole-line cue windows these sit inside a requirement clause and
  // are capitalised at the start of a bullet, so nothing else filters them.
  'deep',
  'solid',
  'advanced',
  'expert',
  'extensive',
  'proven',
  'demonstrated',
  'significant',
  'substantial',
  'hands',
  'broad',
  'proficient',
  'proficiency',
  'familiar',
  'familiarity',
  'comfortable',
  'senior',
  'junior',
  'track',
  'record',
  'knowledge',
  'background',
  'exposure',
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
/**
 * Headings under which a posting lists what it would *like*, not what it needs.
 *
 * Everything after one of these stops counting as a hard requirement. Without
 * it a "Nice to have" section promotes its contents to required, because the
 * cue phrases inside it ("Experience with Datadog…") look identical to the ones
 * above it.
 */
const OPTIONAL_HEADING =
  /^\s*(?:[-•*]\s*)?(?:nice[\s-]to[\s-]haves?|bonus(?:\s+points)?|preferred|desirable|pluses?|a\s+plus|optional|not\s+required)\b.*$/im;

/** Where the posting stops stating requirements and starts stating wishes. */
function optionalFrom(jdText: string): number {
  const m = OPTIONAL_HEADING.exec(jdText);
  return m ? m.index : Infinity;
}

/**
 * The title line, which names the employer rather than a skill.
 *
 * "Senior Platform Engineer — Meridian Logistics" yielded `Meridian` and
 * `Logistics` as things the candidate was missing. A token is only discarded
 * when *every* occurrence is up here: a title like "Senior Go Engineer" names a
 * real requirement, and the body will mention it again.
 */
function headerEnd(jdText: string): number {
  const firstBreak = jdText.indexOf('\n');
  // No title line without a body under it. A single-line posting — or a pasted
  // fragment — is all content, and treating it as a header would discard every
  // requirement in it.
  if (firstBreak === -1 || jdText.slice(firstBreak).trim().length < 40) return -1;
  return firstBreak;
}

export function extractRequirements(jdText: string, limit = 40): Array<{
  term: string;
  norm: string;
  mentions: number;
  emphasised: boolean;
}> {
  const tokens = tokenize(jdText);
  const counts = new Map<string, { term: string; mentions: number; emphasised: boolean }>();

  const optionalAt = optionalFrom(jdText);
  const headerAt = headerEnd(jdText);

  // A line containing a requirement cue is a requirement line, end to end.
  //
  // This replaced a fixed 90-character window that ran forward from each cue.
  // That window did both things wrong at once: it overran the end of one bullet
  // into the next, so "Deep PostgreSQL knowledge" inherited emphasis from the
  // line above it — and it could not see a cue that *follows* its term, which
  // is how postings write half of their hard requirements ("Deep PostgreSQL
  // knowledge — required"). Whole lines handle both, and postings state
  // requirements one per line.
  const cueWindows: Array<[number, number]> = [];
  let lineStart = 0;
  for (const line of jdText.split('\n')) {
    CUE_RE.lastIndex = 0;
    if (CUE_RE.test(line)) cueWindows.push([lineStart, lineStart + line.length]);
    lineStart += line.length + 1;
  }
  const inCueWindow = (i: number) => cueWindows.some(([a, b]) => i >= a && i <= b);

  const outsideHeader = new Set<string>();
  for (const t of tokens) if (t.index > headerAt) outsideHeader.add(t.norm);

  for (const t of tokens) {
    // A wish is not a requirement.
    const emphasised = inCueWindow(t.index) && t.index < optionalAt;
    // A term qualifies either by shape, or by being a capitalised word sitting
    // inside a requirement clause. The capitalisation test is what keeps the
    // cue-window path precise: it admits short tech names that have no
    // distinguishing shape (Go, R, Vue) without dragging in the surrounding
    // prose ("experience", "daily", "exposure").
    const inRequirementClause =
      emphasised && !NOISE.has(t.norm) && t.norm.length >= 2 && /^[A-Z]/.test(t.raw);
    if (!looksLikeSkill(t.raw, t.norm) && !inRequirementClause) continue;
    // Named only in the title: the employer, not a skill.
    if (!outsideHeader.has(t.norm)) continue;
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
/**
 * A crude stem, for coverage only.
 *
 * The guard and this module want opposite mistakes. A guard that matches too
 * loosely lets a fabrication through, so `equivalentForms` is deliberately
 * conservative. Coverage that matches too *strictly* tells someone they lack a
 * skill they have, which is the worse failure here — the posting asked for
 * "Sharding" and the profile said "Resharded the shipment ledger", and the
 * report called it a genuine gap.
 *
 * So this stays local. Widening `equivalentForms` to fix coverage would have
 * quietly weakened the fabrication guard, which is the one thing in this
 * codebase that must not get looser.
 *
 * Suffix stripping only, and no `-er`: "docker" must not collapse to "dock".
 */
function stem(word: string): string {
  if (word.length < 5) return word;
  let w = word;
  for (const suffix of ['ings', 'ing', 'ions', 'ion', 'ments', 'ment', 'ed', 'es', 's']) {
    if (w.length - suffix.length >= 4 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  // "resharded" -> "reshard" -> "shard", so a re-done thing matches the thing.
  if (w.length >= 6 && w.startsWith('re')) w = w.slice(2);
  return w;
}

function stemSet(source: unknown): Set<string> {
  const out = new Set<string>();
  for (const form of buildLexicon(source)) out.add(stem(form));
  return out;
}

export function buildCoverage(
  jdText: string,
  resumeSlices: ResumeSlice[],
  profile: Profile,
): CoverageReport {
  const requirements = extractRequirements(jdText);
  const profileLex = buildLexicon(profile);
  const profileStems = stemSet(profile);

  const sliceLexicons = resumeSlices.map((s) => ({
    label: s.label,
    lex: buildLexicon(s.text),
    stems: stemSet(s.text),
  }));

  const terms: CoverageTerm[] = requirements.map((r) => {
    const rootedIn = (lex: Set<string>, stems: Set<string>) =>
      isGrounded(r.norm, lex) || stems.has(stem(r.norm));

    const locations = sliceLexicons.filter((s) => rootedIn(s.lex, s.stems)).map((s) => s.label);
    const inProfile = rootedIn(profileLex, profileStems);
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
