import { ids } from '../ids';
import { isOngoing, rangesOverlap } from '../dates';
import { tokenize } from '../tailor/lexicon';
import { isCommonSentenceOpener } from '../tailor/stopwords';
import {
  profileSchema,
  type Award,
  type Bullet,
  type Certificate,
  type Education,
  type Profile,
  type Project,
  type SkillGroup,
  type Work,
} from '../schema';

/**
 * Merging a second source into an existing master profile.
 *
 * The profile is the document of record, so a wrong merge corrupts the thing
 * every future tailoring run is grounded in. Two consequences shape this whole
 * module:
 *
 *   1. **No LLM.** Matching is deterministic, explainable, and testable. A
 *      model deciding "these two roles are the same" would be unauditable at
 *      exactly the point where being wrong is most expensive.
 *   2. **Nothing is applied without a decision.** `planMerge` only proposes.
 *      `applyMerge` is a pure function of (profile, plan, decisions), which is
 *      the same shape as `tailor/apply.ts` and for the same reason.
 *
 * The append-only guarantee survives: merging never edits or deletes existing
 * canonical text. A bullet that is a *rewording* of one already on file becomes
 * a `variant` of it — which is what variants are for — and an exact repeat is
 * dropped. That makes re-importing a resume you had already polished enrich the
 * profile rather than duplicate it, and it is why merging a profile into itself
 * is a no-op.
 */

export type MergeAction = 'add' | 'merge' | 'skip';

export type MergeSection =
  | 'work'
  | 'projects'
  | 'education'
  | 'skills'
  | 'certificates'
  | 'awards'
  | 'languages';

export interface EntryMatch {
  /** ID of the existing entry this appears to be. */
  id: string;
  /** 0–1. Above `STRONG_MATCH` we suggest merging, below it we suggest adding. */
  confidence: number;
  /** Shown to the user. A match they cannot understand is a match they cannot check. */
  reason: string;
}

export interface BulletCandidate {
  key: string;
  incoming: Bullet;
  /** ID of the existing bullet this rewords, when there is one. */
  duplicateOf: string | null;
  similarity: number;
  /** `add` new line · `merge` store as a variant · `skip` drop it. */
  suggested: MergeAction;
  reason: string;
}

export interface EntryCandidate<T> {
  key: string;
  section: MergeSection;
  incoming: T;
  match: EntryMatch | null;
  suggested: MergeAction;
  /** Empty for sections that have no bullets. */
  bullets: BulletCandidate[];
  /** Dates on a matched entry that the incoming source disagrees with. */
  fields: FieldChange[];
}

/**
 * A correction to a dated field on an entry that already exists.
 *
 * The append-only rule protects *text* — a canonical bullet is never rewritten,
 * because losing the user's own words is unrecoverable. A date is different: it
 * is a single fact with one correct value, and refusing to ever change one
 * produces documents that are simply wrong. Leaving a role open-ended after the
 * person has said they left it puts two concurrent "Present" jobs on the
 * resume, which any reader notices.
 *
 * So dates are correctable, but never silently. Every change is surfaced with
 * both values, and the default is the conservative one except in the single
 * case where the incoming value is strictly more specific than a blank.
 */
export interface FieldChange {
  key: string;
  /** Human label, e.g. "End date · Northwind Payments". */
  label: string;
  current: string;
  incoming: string;
  suggested: MergeAction;
  reason: string;
}

export interface BasicsChange {
  key: string;
  /** Human label for the field, e.g. "Email". */
  label: string;
  current: string;
  incoming: string;
  /** `add` takes the incoming value, `skip` keeps what is there. */
  suggested: MergeAction;
}

export interface ProfileMerge {
  basics: BasicsChange[];
  work: Array<EntryCandidate<Work>>;
  projects: Array<EntryCandidate<Project>>;
  education: Array<EntryCandidate<Education>>;
  skills: Array<EntryCandidate<SkillGroup>>;
  certificates: Array<EntryCandidate<Certificate>>;
  awards: Array<EntryCandidate<Award>>;
  languages: Array<EntryCandidate<Language>>;
}

type Language = Profile['languages'][number];

/**
 * Jaccard overlap above which two bullets are the same fact reworded.
 *
 * Tuned against the fixtures in `merge.test.ts`. It is deliberately a single
 * exported constant: the right value is an empirical question, and burying it
 * in a comparison would make it impossible to retune against real resumes.
 */
export const DUPLICATE_THRESHOLD = 0.6;

/** Confidence at or above which a match is strong enough to suggest merging. */
export const STRONG_MATCH = 0.8;

/* ------------------------------------------------------------------ *
 * Text comparison
 * ------------------------------------------------------------------ */

/**
 * Company and institution names, reduced to something comparable.
 *
 * Legal suffixes are dropped so "Northwind Payments, Inc." and "Northwind
 * Payments" are one employer. `stopwords.GENERIC_TERMS` contains these but also
 * words like "team" and "role" that are meaningful inside a company name, so
 * this list stays separate and small.
 */
const LEGAL_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'limited', 'corp', 'co', 'gmbh', 'plc', 'sa', 'bv', 'ag']);

export function normalizeName(raw: string): string {
  return tokenize(raw)
    .map((t) => t.norm)
    .filter((n) => !LEGAL_SUFFIXES.has(n))
    .join(' ');
}

/** Every token of a string, normalised, in order. Used for exact comparison. */
function normalizeText(raw: string): string {
  return tokenize(raw)
    .map((t) => t.norm)
    .join(' ');
}

/**
 * The tokens that carry meaning, for overlap scoring.
 *
 * `isCommonSentenceOpener` already unions the common-verb allowlist, calendar
 * words and generic resume nouns that the fabrication guard uses to avoid
 * false positives. The same words are the ones that make two unrelated bullets
 * look similar, so the guard's list is reused rather than reinvented — one
 * tokenisation story for the whole codebase.
 */
function contentTokens(raw: string): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(raw)) {
    if (!isCommonSentenceOpener(t.norm)) out.add(t.norm);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const v of a) if (b.has(v)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * 1 means "the same fact"; anything lower is a judgement call.
 *
 * Short bullets are scored by exact match only. Jaccard over three or four
 * tokens swings wildly — "Shipped the dashboard" and "Shipped the API" would
 * score 0.5 and be filed as rewordings of each other.
 *
 * Two signals, because one is not enough:
 *
 *   - **Overlap** catches rewording, where the same fact is said with different
 *     verbs. Jaccard handles this well.
 *   - **Containment** catches elaboration, where a later version of a resume
 *     adds a metric to a bullet you already had. Jaccard is actively wrong
 *     here: measured against real pairs, "Built a FHIR ingestion pipeline" vs
 *     "…handling 40 million records per day" scores 0.33, *below* two bullets
 *     that describe genuinely different work (0.38). No threshold can separate
 *     those, so a longer bullet whose content tokens strictly contain a shorter
 *     one is treated as the same fact regardless of overlap.
 *
 * The short-bullet floor is what keeps containment safe: "Led the team" is all
 * stopwords, so it never reaches this comparison at all.
 */
export function bulletSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na && na === nb) return 1;

  const ta = contentTokens(a);
  const tb = contentTokens(b);
  if (ta.size < 3 || tb.size < 3) return 0;

  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const v of smaller) if (larger.has(v)) shared++;
  if (shared === smaller.size) return 1; // elaboration of the same fact

  return jaccard(ta, tb);
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

function matchWork(incoming: Work, existing: Work[]): EntryMatch | null {
  const name = normalizeName(incoming.name);
  if (!name) return null;

  const sameEmployer = existing.filter((w) => normalizeName(w.name) === name);
  const first = sameEmployer[0];
  if (!first) return null;

  const overlapping = sameEmployer.find((w) => rangesOverlap(w, incoming));
  if (overlapping) {
    return { id: overlapping.id, confidence: 0.95, reason: 'Same employer, overlapping dates' };
  }

  // A second, non-overlapping stint at one employer is a real thing — a
  // promotion recorded as its own entry, or a return years later. Adding is the
  // safer default, and the reason tells the user it is theirs to check.
  return {
    id: first.id,
    confidence: 0.5,
    reason: 'Same employer but the dates do not overlap — probably a separate stint',
  };
}

/** URLs differ by scheme, `www.`, and trailing slash far more often than by identity. */
function normalizeUrl(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

function matchProject(incoming: Project, existing: Project[]): EntryMatch | null {
  const url = normalizeUrl(incoming.url);
  if (url) {
    const byUrl = existing.find((p) => normalizeUrl(p.url) === url);
    if (byUrl) return { id: byUrl.id, confidence: 1, reason: 'Same URL' };
  }

  const name = normalizeName(incoming.name);
  if (!name) return null;

  const byName = existing.find((p) => normalizeName(p.name) === name);
  return byName ? { id: byName.id, confidence: 0.9, reason: 'Same project name' } : null;
}

function matchEducation(incoming: Education, existing: Education[]): EntryMatch | null {
  const institution = normalizeName(incoming.institution);
  if (!institution) return null;

  const same = existing.filter((e) => normalizeName(e.institution) === institution);
  const first = same[0];
  if (!first) return null;

  const area = normalizeName(incoming.area);
  const byArea = same.find((e) => normalizeName(e.area) === area);
  if (byArea) return { id: byArea.id, confidence: 0.95, reason: 'Same institution and field' };

  // Two degrees from one university is ordinary. Do not fold them together.
  return {
    id: first.id,
    confidence: 0.5,
    reason: 'Same institution, different field — probably a separate qualification',
  };
}

/** For sections identified by one or two plain names. */
function matchByFields<T extends { id: string }>(
  incoming: T,
  existing: T[],
  fields: Array<(x: T) => string>,
  reason: string,
): EntryMatch | null {
  const key = fields.map((f) => normalizeName(f(incoming))).join('|');
  if (!key.replace(/\|/g, '')) return null;

  const hit = existing.find((x) => fields.map((f) => normalizeName(f(x))).join('|') === key);
  return hit ? { id: hit.id, confidence: 0.95, reason } : null;
}

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

function planBullets(
  sectionKey: string,
  incoming: Bullet[],
  target: { bullets: Bullet[] } | null,
): BulletCandidate[] {
  return incoming
    .filter((b) => b.text.trim())
    .map((b) => {
      const key = `${sectionKey}/${b.id}`;

      if (!target) {
        // No existing entry to compare against — every bullet is new.
        return { key, incoming: b, duplicateOf: null, similarity: 0, suggested: 'add' as const, reason: 'New' };
      }

      let bestBullet: Bullet | null = null;
      let bestScore = 0;
      for (const existing of target.bullets) {
        const score = bulletSimilarity(b.text, existing.text);
        if (score > bestScore) {
          bestBullet = existing;
          bestScore = score;
        }
      }

      if (!bestBullet || bestScore < DUPLICATE_THRESHOLD) {
        return { key, incoming: b, duplicateOf: null, similarity: bestScore, suggested: 'add' as const, reason: 'New' };
      }

      // Word-for-word repeat, of the canonical text or of a phrasing already
      // stored. Storing it again would add nothing.
      const norm = normalizeText(b.text);
      const alreadyKnown =
        normalizeText(bestBullet.text) === norm ||
        bestBullet.variants.some((v) => normalizeText(v.text) === norm);

      if (alreadyKnown) {
        return {
          key,
          incoming: b,
          duplicateOf: bestBullet.id,
          similarity: bestScore,
          suggested: 'skip' as const,
          reason: 'Already on this entry, word for word',
        };
      }

      return {
        key,
        incoming: b,
        duplicateOf: bestBullet.id,
        similarity: bestScore,
        suggested: 'merge' as const,
        reason: 'Reworded version of a bullet already on this entry — keep as an alternate phrasing',
      };
    });
}

const isOpenEnded = isOngoing;

/**
 * Dates on a matched entry that the incoming source states differently.
 *
 * The one case defaulted to `add` is closing out an open-ended role: the
 * profile says "Present", the incoming source names a month. That is not a
 * conflict between two claims, it is the answer to a question the profile could
 * not represent — and leaving it produces two overlapping current jobs. Two
 * concrete dates that disagree *are* a conflict, and the existing one wins
 * until the user says otherwise.
 */
function planDateFields(key: string, incoming: Work, existing: Work): FieldChange[] {
  const label = `${existing.position} · ${existing.name}`;
  const out: FieldChange[] = [];

  for (const field of ['startDate', 'endDate'] as const) {
    const current = existing[field].trim();
    const next = incoming[field].trim();
    if (!next || next === current) continue;

    const closingOut = field === 'endDate' && isOpenEnded(current) && !isOpenEnded(next);
    const fillingBlank = !current;

    out.push({
      key: `${key}.${field}`,
      label: `${field === 'endDate' ? 'End date' : 'Start date'} · ${label}`,
      current: current || '(blank)',
      incoming: next,
      suggested: closingOut || fillingBlank ? 'add' : 'skip',
      reason: closingOut
        ? 'This role is still marked as current. Leaving it open puts two concurrent jobs on the resume.'
        : fillingBlank
          ? 'No date was recorded for this role.'
          : 'Both dates are specific and they disagree. The existing one is kept unless you say otherwise.',
    });
  }

  return out;
}

function planEntries<T extends { id: string; bullets?: Bullet[] }>(
  section: MergeSection,
  incoming: T[],
  existing: T[],
  match: (x: T, pool: T[]) => EntryMatch | null,
): Array<EntryCandidate<T>> {
  return incoming.map((entry) => {
    const key = `${section}:${entry.id}`;
    const found = match(entry, existing);
    const merging = found !== null && found.confidence >= STRONG_MATCH;
    const target = merging ? (existing.find((e) => e.id === found.id) ?? null) : null;

    return {
      key,
      section,
      incoming: entry,
      match: found,
      suggested: merging ? ('merge' as const) : ('add' as const),
      bullets: entry.bullets ? planBullets(key, entry.bullets, target as { bullets: Bullet[] } | null) : [],
      fields:
        section === 'work' && target
          ? planDateFields(key, entry as unknown as Work, target as unknown as Work)
          : [],
    };
  });
}

const BASICS_FIELDS: Array<{ key: string; label: string; get: (p: Profile) => string }> = [
  { key: 'basics.name', label: 'Full name', get: (p) => p.basics.name },
  { key: 'basics.label', label: 'Headline', get: (p) => p.basics.label },
  { key: 'basics.email', label: 'Email', get: (p) => p.basics.email },
  { key: 'basics.phone', label: 'Phone', get: (p) => p.basics.phone },
  { key: 'basics.url', label: 'Website', get: (p) => p.basics.url },
  { key: 'basics.summary', label: 'Summary', get: (p) => p.basics.summary },
  { key: 'basics.location.city', label: 'City', get: (p) => p.basics.location.city ?? '' },
  { key: 'basics.location.region', label: 'Region', get: (p) => p.basics.location.region ?? '' },
];

function planBasics(existing: Profile, incoming: Profile): BasicsChange[] {
  const changes: BasicsChange[] = [];

  for (const field of BASICS_FIELDS) {
    const current = field.get(existing).trim();
    const next = field.get(incoming).trim();
    if (!next || next === current) continue;

    changes.push({
      key: field.key,
      label: field.label,
      current,
      incoming: next,
      // Filling a blank is safe. Replacing something the user already has is a
      // conflict, and the existing value wins until they say otherwise —
      // basics are overwritten rather than appended, so a wrong default here
      // destroys data instead of just adding noise.
      suggested: current ? 'skip' : 'add',
    });
  }

  return changes;
}

/**
 * Works out what merging `incoming` into `existing` would do. Changes nothing.
 *
 * Every candidate carries a `key`; the UI collects `key -> MergeAction` and
 * hands the result to `applyMerge`.
 */
export function planMerge(existing: Profile, incoming: Profile): ProfileMerge {
  return {
    basics: planBasics(existing, incoming),
    work: planEntries('work', incoming.work, existing.work, matchWork),
    projects: planEntries('projects', incoming.projects, existing.projects, matchProject),
    education: planEntries('education', incoming.education, existing.education, matchEducation),
    skills: planEntries('skills', incoming.skills, existing.skills, (x, pool) =>
      matchByFields(x, pool, [(s) => s.name], 'Same skill group'),
    ),
    certificates: planEntries('certificates', incoming.certificates, existing.certificates, (x, pool) =>
      matchByFields(x, pool, [(c) => c.name, (c) => c.issuer], 'Same certificate and issuer'),
    ),
    awards: planEntries('awards', incoming.awards, existing.awards, (x, pool) =>
      matchByFields(x, pool, [(a) => a.title, (a) => a.awarder], 'Same award'),
    ),
    languages: planEntries('languages', incoming.languages, existing.languages, (x, pool) =>
      matchByFields(x, pool, [(l) => l.language], 'Same language'),
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Applying
 * ------------------------------------------------------------------ */

export interface ApplyMergeOptions {
  /** `key -> action`. Anything absent falls back to the candidate's `suggested`. */
  decisions?: Record<string, MergeAction>;
  /** Where this content came from, recorded on any variant we store. */
  sourceLabel?: string;
  now?: string;
}

const decide = (c: { key: string; suggested: MergeAction }, d: Record<string, MergeAction>) =>
  d[c.key] ?? c.suggested;

/** A copy with brand-new IDs. Incoming IDs are never trusted — see `applyMerge`. */
function freshBullet(b: Bullet): Bullet {
  return {
    id: ids.bullet(),
    text: b.text.trim(),
    tags: [...b.tags],
    variants: b.variants.map((v) => ({ ...v, id: ids.variant() })),
  };
}

/**
 * Records an alternate phrasing, unless we already have it.
 *
 * Checked here as well as in `planMerge` because the user can override any
 * suggestion, and "append-only" must not mean "accumulates duplicates".
 */
function appendVariant(target: Bullet, text: string, note: string | undefined, now: string): boolean {
  const norm = normalizeText(text);
  if (!norm) return false;
  if (normalizeText(target.text) === norm) return false;
  if (target.variants.some((v) => normalizeText(v.text) === norm)) return false;

  target.variants.push({
    id: ids.variant(),
    text: text.trim(),
    // The user wrote this in a document of their own; it is not model output.
    source: 'original',
    createdAt: now,
    ...(note ? { note } : {}),
  });
  return true;
}

function applyBullets(
  target: { bullets: Bullet[] },
  candidates: BulletCandidate[],
  decisions: Record<string, MergeAction>,
  sourceLabel: string | undefined,
  now: string,
): void {
  for (const candidate of candidates) {
    const action = decide(candidate, decisions);
    if (action === 'skip') continue;

    if (action === 'merge' && candidate.duplicateOf) {
      const existing = target.bullets.find((b) => b.id === candidate.duplicateOf);
      if (existing) {
        appendVariant(existing, candidate.incoming.text, sourceLabel, now);
        continue;
      }
      // The target bullet is gone. Falling through to `add` keeps the content
      // rather than silently dropping it.
    }

    target.bullets.push(freshBullet(candidate.incoming));
  }
}

function applyEntries<T extends { id: string; bullets?: Bullet[] }>(
  target: T[],
  candidates: Array<EntryCandidate<T>>,
  decisions: Record<string, MergeAction>,
  sourceLabel: string | undefined,
  now: string,
  mintId: () => string,
  onMerge?: (existing: T, incoming: T) => void,
): void {
  for (const candidate of candidates) {
    const action = decide(candidate, decisions);
    if (action === 'skip') continue;

    if (action === 'merge' && candidate.match) {
      const existing = target.find((e) => e.id === candidate.match!.id);
      if (existing) {
        if (existing.bullets) {
          applyBullets(existing as { bullets: Bullet[] }, candidate.bullets, decisions, sourceLabel, now);
        }
        for (const field of candidate.fields) {
          if (decide(field, decisions) !== 'add') continue;
          const name = field.key.endsWith('endDate') ? 'endDate' : 'startDate';
          // Only ever write a real value. A correction must not blank a date.
          if (field.incoming.trim()) (existing as unknown as Work)[name] = field.incoming.trim();
        }
        onMerge?.(existing, candidate.incoming);
        continue;
      }
    }

    const bullets = candidate.bullets
      .filter((b) => decide(b, decisions) !== 'skip')
      .map((b) => freshBullet(b.incoming));

    target.push({
      ...candidate.incoming,
      id: mintId(),
      ...(candidate.incoming.bullets ? { bullets } : {}),
    });
  }
}

/** Case-insensitive union that keeps the existing order and the existing casing. */
function unionKeywords(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing.map((k) => k.trim().toLowerCase()));
  const out = [...existing];
  for (const k of incoming) {
    const norm = k.trim().toLowerCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(k.trim());
  }
  return out;
}

const BASICS_SETTERS: Record<string, (p: Profile, v: string) => void> = {
  'basics.name': (p, v) => void (p.basics.name = v),
  'basics.label': (p, v) => void (p.basics.label = v),
  'basics.email': (p, v) => void (p.basics.email = v),
  'basics.phone': (p, v) => void (p.basics.phone = v),
  'basics.url': (p, v) => void (p.basics.url = v),
  'basics.summary': (p, v) => void (p.basics.summary = v),
  'basics.location.city': (p, v) => void (p.basics.location.city = v),
  'basics.location.region': (p, v) => void (p.basics.location.region = v),
};

/**
 * Produces the merged profile. Pure: `existing` is not touched.
 *
 * Every entry and bullet that gets added is given a freshly minted ID. IDs
 * arriving from a parsed document are meaningless, and reusing one could
 * re-point a stored tailoring run at a fact it was never about.
 */
export function applyMerge(
  existing: Profile,
  merge: ProfileMerge,
  opts: ApplyMergeOptions = {},
): Profile {
  const { decisions = {}, sourceLabel, now = new Date().toISOString() } = opts;
  const next = structuredClone(existing);

  for (const change of merge.basics) {
    if (decide(change, decisions) === 'add') BASICS_SETTERS[change.key]?.(next, change.incoming);
  }

  applyEntries(next.work, merge.work, decisions, sourceLabel, now, ids.work);
  applyEntries(next.projects, merge.projects, decisions, sourceLabel, now, ids.project);
  applyEntries(next.education, merge.education, decisions, sourceLabel, now, ids.education);
  applyEntries(next.certificates, merge.certificates, decisions, sourceLabel, now, ids.cert);
  applyEntries(next.awards, merge.awards, decisions, sourceLabel, now, ids.award);
  applyEntries(next.languages, merge.languages, decisions, sourceLabel, now, ids.language);
  applyEntries(next.skills, merge.skills, decisions, sourceLabel, now, ids.skill, (target, incoming) => {
    target.keywords = unionKeywords(target.keywords, incoming.keywords);
  });

  next.updatedAt = now;

  // Same discipline as `rawToProfile`: whatever leaves this function is a
  // profile the schema accepts, or it does not leave.
  return profileSchema.parse(next);
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

export interface MergeSummary {
  newEntries: number;
  mergedEntries: number;
  newBullets: number;
  newVariants: number;
  basicsChanged: number;
  /** Dates corrected on entries that already existed. */
  datesCorrected: number;
  skipped: number;
}

/** Counts for the confirmation header, under the decisions currently made. */
export function summarizeMerge(
  merge: ProfileMerge,
  decisions: Record<string, MergeAction> = {},
): MergeSummary {
  const summary: MergeSummary = {
    newEntries: 0,
    mergedEntries: 0,
    newBullets: 0,
    newVariants: 0,
    basicsChanged: 0,
    datesCorrected: 0,
    skipped: 0,
  };

  for (const change of merge.basics) {
    if (decide(change, decisions) === 'add') summary.basicsChanged++;
  }

  const sections: Array<Array<EntryCandidate<{ id: string; bullets?: Bullet[] }>>> = [
    merge.work,
    merge.projects,
    merge.education,
    merge.skills,
    merge.certificates,
    merge.awards,
    merge.languages,
  ];

  for (const section of sections) {
    for (const candidate of section) {
      const action = decide(candidate, decisions);
      if (action === 'skip') {
        summary.skipped++;
        continue;
      }

      if (action === 'merge') summary.mergedEntries++;
      else summary.newEntries++;

      for (const field of candidate.fields) {
        if (decide(field, decisions) === 'add') summary.datesCorrected++;
      }

      for (const bullet of candidate.bullets) {
        const bulletAction = decide(bullet, decisions);
        if (bulletAction === 'skip') summary.skipped++;
        else if (bulletAction === 'merge' && action === 'merge') summary.newVariants++;
        else summary.newBullets++;
      }
    }
  }

  return summary;
}
