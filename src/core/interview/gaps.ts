import type { Profile } from '../schema';
import { buildCoverage } from '../tailor/coverage';
import { buildLexicon, isGrounded } from '../tailor/lexicon';
import { isOngoing, toMonths } from '../dates';

/**
 * What to ask about, and in what order.
 *
 * The point of a twenty-questions interview is that each question is the most
 * informative one available. So question *selection* is computed here, from
 * measured gaps in the profile — the model only phrases the question and reads
 * the answer back. Same division as `plan.ts`: deterministic code decides, the
 * model writes prose. A model choosing its own topics wanders into "tell me
 * about your leadership philosophy".
 *
 * Nothing here needs a network call, so the ranking is testable and free.
 */

export type GapKind =
  | 'recent-work'
  | 'missing-requirement'
  | 'unbacked-skill'
  | 'thin-role'
  | 'undated-role'
  | 'no-summary';

export interface Gap {
  id: string;
  kind: GapKind;
  /** The term or entry the question is about. */
  subject: string;
  /** Profile entry the answer should attach to, when there is an obvious one. */
  ownerId: string | null;
  ownerLabel: string;
  /** Shown to the user. A question whose purpose is invisible feels like an interrogation. */
  why: string;
  /** Higher is more worth asking. */
  weight: number;
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * A skill listed in the sidebar that no bullet demonstrates.
 *
 * These are the highest-value questions in the set: the candidate has already
 * told us they can do the thing, so we are not fishing — we are asking them to
 * evidence a claim they have made. A keyword with no story behind it is the
 * weakest line on any resume.
 */
function unbackedSkills(profile: Profile, emphasised: Set<string>): Gap[] {
  const bulletText = [
    ...profile.work.flatMap((w) => w.bullets.map((b) => b.text)),
    ...profile.projects.flatMap((p) => p.bullets.map((b) => b.text)),
  ].join('\n');
  const evidence = buildLexicon(bulletText);

  const gaps: Gap[] = [];
  for (const group of profile.skills) {
    for (const keyword of group.keywords) {
      // Compound entries like "Firebase (Authentication, Firestore)" are really
      // several keywords; the head is the one worth asking about.
      const head = keyword.split(/[(/,]/)[0]?.trim() ?? keyword;
      if (head.length < 2 || isGrounded(norm(head), evidence)) continue;

      gaps.push({
        id: `unbacked:${norm(head).replace(/\s+/g, '-')}`,
        kind: 'unbacked-skill',
        subject: head,
        ownerId: null,
        ownerLabel: group.name,
        why: `You list ${head} as a skill, but no bullet shows you using it.`,
        // A skill the posting also asks for is worth far more than one it does not.
        weight: emphasised.has(norm(head)) ? 90 : 40,
      });
    }
  }
  return gaps;
}

/**
 * Work the profile does not know about.
 *
 * This is the one question that cannot be derived from what is already there,
 * and it is also the most expensive omission on any resume — a job you have
 * held for months and never added. Every other gap kind reasons about content
 * that exists; this one reasons about a silence.
 *
 * Two shapes, and only the first is detectable from the data:
 *
 *   1. The most recent role *ended*, months ago. That is a visible hole in the
 *      timeline, and a reader will assume the worst about it.
 *   2. The most recent role says "Present". The profile claims the person is
 *      still there, so nothing in it can reveal that they left. The only way to
 *      find out is to ask, so we ask — once, cheaply. "No, nothing new" costs a
 *      single turn and produces no bullets.
 *
 * Weighted at the top either way. A missing current job invalidates everything
 * downstream of it.
 */
function recentWork(profile: Profile, now: Date): Gap[] {
  const nowMonths = now.getUTCFullYear() * 12 + now.getUTCMonth();

  if (!profile.work.length) {
    return [
      {
        id: 'recent:none',
        kind: 'recent-work',
        subject: 'Work history',
        ownerId: null,
        ownerLabel: 'Experience',
        why: 'There is no work history on this profile at all.',
        weight: 120,
      },
    ];
  }

  const dated = profile.work
    .map((w) => ({ w, end: isOngoing(w.endDate) ? Infinity : toMonths(w.endDate) }))
    .filter((x) => x.end !== null) as Array<{ w: Profile['work'][number]; end: number }>;

  const latest = dated.sort((a, b) => b.end - a.end)[0];
  if (!latest) return [];

  if (latest.end === Infinity) {
    return [
      {
        id: 'recent:since-current',
        kind: 'recent-work',
        subject: 'Any newer role',
        ownerId: null,
        ownerLabel: 'Experience',
        why: `This profile says you are still at ${latest.w.name}. If you have started somewhere new since, nothing here can tell.`,
        weight: 95,
      },
    ];
  }

  const monthsSince = nowMonths - latest.end;
  if (monthsSince < 2) return [];

  return [
    {
      id: 'recent:gap',
      kind: 'recent-work',
      subject: `The ${monthsSince} months since ${latest.w.name}`,
      ownerId: null,
      ownerLabel: 'Experience',
      why: `Your most recent role ended ${monthsSince} months ago. An unexplained gap is read as the worst possible explanation.`,
      weight: 120,
    },
  ];
}

/** Roles with too little on them to be worth reading. */
function thinRoles(profile: Profile): Gap[] {
  return profile.work
    .filter((w) => w.bullets.length < 3)
    .map((w) => {
      const current = isOngoing(w.endDate);
      return {
        id: `thin:${w.id}`,
        kind: 'thin-role' as const,
        subject: `${w.position} at ${w.name}`,
        ownerId: w.id,
        ownerLabel: `${w.position} · ${w.name}`,
        why: current
          ? `Your current role has only ${w.bullets.length} bullet(s). This is the work employers read first.`
          : `${w.name} has only ${w.bullets.length} bullet(s) to choose from.`,
        // The job you are in now is the one a tailored resume leans on hardest.
        weight: current ? 100 : 55,
      };
    });
}

function undatedRoles(profile: Profile): Gap[] {
  return profile.work
    .filter((w) => !w.startDate && !w.endDate)
    .map((w) => ({
      id: `dates:${w.id}`,
      kind: 'undated-role' as const,
      subject: `${w.position} at ${w.name}`,
      ownerId: w.id,
      ownerLabel: `${w.position} · ${w.name}`,
      why: 'This role has no dates. A reader assumes the worst about an unexplained gap.',
      weight: 70,
    }));
}

/**
 * Requirements the posting stresses that appear nowhere in the profile.
 *
 * Deliberately the *lowest*-weighted kind. A missing requirement is usually
 * missing because the candidate genuinely has not done it, and asking produces
 * either an honest "no" or an invitation to embellish. Asking someone to
 * evidence a skill they already claim is a better use of a question.
 */
function missingRequirements(profile: Profile, jdText: string): Gap[] {
  if (!jdText.trim()) return [];

  return buildCoverage(jdText, [], profile)
    .missing.filter((t) => t.emphasised)
    .map((t) => ({
      id: `requirement:${t.norm}`,
      kind: 'missing-requirement' as const,
      subject: t.term,
      ownerId: null,
      ownerLabel: 'Posting',
      why: `The posting mentions ${t.term} ${t.mentions} time(s) and nothing in your profile does.`,
      weight: 20 + Math.min(t.mentions, 5),
    }));
}

export interface FindGapsOptions {
  jdText?: string;
  /** Hard cap. The game is worth playing only if it ends. */
  limit?: number;
  /** Injected so "how long since your last role ended" is testable. */
  now?: Date;
}

export function findGaps(profile: Profile, opts: FindGapsOptions = {}): Gap[] {
  const { jdText = '', limit = 12, now = new Date() } = opts;

  const emphasised = new Set(
    jdText.trim()
      ? buildCoverage(jdText, [], profile)
          .terms.filter((t) => t.emphasised)
          .map((t) => norm(t.term))
      : [],
  );

  const gaps = [
    ...recentWork(profile, now),
    ...thinRoles(profile),
    ...undatedRoles(profile),
    ...unbackedSkills(profile, emphasised),
    ...missingRequirements(profile, jdText),
  ];

  if (!profile.basics.summary.trim()) {
    gaps.push({
      id: 'summary',
      kind: 'no-summary',
      subject: 'Professional summary',
      ownerId: null,
      ownerLabel: 'Basics',
      why: 'There is no summary to tailor from.',
      weight: 65,
    });
  }

  return gaps.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id)).slice(0, limit);
}

/**
 * Drops questions an earlier answer has already covered.
 *
 * This is what makes the remaining-question count fall faster than one per
 * answer, and it is the whole reason the format feels like twenty questions
 * rather than a form: describe a Kotlin bridge module and the Kotlin question
 * disappears along with it.
 */
export function remainingGaps(gaps: Gap[], answeredText: string[]): Gap[] {
  if (!answeredText.length) return gaps;
  const covered = buildLexicon(answeredText.join('\n'));

  return gaps.filter((gap) => {
    if (gap.kind === 'unbacked-skill' || gap.kind === 'missing-requirement') {
      return !isGrounded(norm(gap.subject), covered);
    }
    return true;
  });
}
