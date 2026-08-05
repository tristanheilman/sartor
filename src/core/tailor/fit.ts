import type { Profile } from '../schema';
import { buildChanges, buildDocument } from './apply';
import { estimateHeight, pageHeight, type PageMetrics } from '../render/model';
import { buildLexicon, tokenize } from './lexicon';
import { isCommonSentenceOpener } from './stopwords';
import type { TailorPlan, PlannedEntry } from './plan';

/**
 * Making the resume actually fit the page it was asked to fit.
 *
 * The prompt has always carried a length budget, and the model has never
 * reliably honoured it. Three runs of the same profile against the same posting
 * produced fifteen bullets over two pages, then ten over two, then twenty-five
 * over three — with the instruction growing more specific each time. The last
 * of those was told "roughly 6 bullets" and "at most 3 projects", and returned
 * twenty-five bullets across five projects.
 *
 * That is not a prompt to be tuned. Length is arithmetic, and this project's
 * whole division of labour says arithmetic belongs in code: `gaps.ts` decides
 * what to ask and the model phrases it; `guard.ts` decides what is grounded and
 * the model does not get a vote. Fitting a page is the same shape of problem.
 *
 * So the plan comes back, and then this trims it until it fits. Nothing is
 * rewritten and nothing is invented — bullets are only ever switched from
 * `include: true` to `include: false`, which is a state the plan already models
 * and the review screen already renders as a change the user can reject.
 *
 * ## What gets cut first
 *
 * The model ranked the content; this respects that ranking and only ever
 * removes from the end of it. Within that, the order of sacrifice is:
 *
 *   1. Project bullets, from the project the posting cares about *least*.
 *   2. Whole projects, once one is down to a single bullet — a heading and one
 *      line costs three lines to say almost nothing.
 *   3. Role bullets, from the oldest role with the most, working up.
 *
 * The most relevant project is held back until every other project is gone, so
 * a page spent on projects is spent on the one the posting asked about. The
 * first version of this ranked by size instead, and produced a resume with no
 * projects at all for a posting whose nice-to-haves were "published
 * open-source React Native libraries" — while the summary still said the
 * person published them.
 *
 * Roles are never dropped whole. A missing job leaves a gap in a timeline that
 * a reader fills in for themselves, badly, and no amount of saved space is
 * worth that. Every role keeps at least one bullet for the same reason.
 *
 * Only what the plan mentions can be trimmed. `buildDocument` treats an entry
 * the plan is silent about as kept, so silence is not a drop — but the prompt
 * requires `include: false` over omission precisely so the plan stays a
 * complete account of the profile, and every plan a provider returns covers
 * everything.
 */

/** The default template's metrics, when the caller does not say which. */
const DEFAULT_METRICS: PageMetrics = {
  baseSize: 10,
  lineHeight: 1.4,
  pageMargin: 42,
  sectionGap: 12,
  entryGap: 9,
  bulletGap: 3,
  headingRule: true,
};

/**
 * Points held back from the page.
 *
 * One margin, used for both cutting and filling. Two — a conservative one for
 * the trim and a generous one for the fill — gave the pass hysteresis: the trim
 * cut to the lower line, the fill rose to the upper one, and running it again
 * cut and refilled the same bullet forever.
 *
 * Small, because `estimateHeight` now works from the template's own leading and
 * gaps and reads about three percent *high* against a rendered page. That
 * pessimism is the real safety margin; this is the allowance for character
 * width, which is the one thing still approximated.
 */
const SAFETY_POINTS = 4;

export interface FitResult {
  plan: TailorPlan;
  /**
   * A project the model dropped that the posting asked for, put back — or null,
   * which is the usual answer.
   */
  reinstated: string | null;
  /** Bullet ids switched off to make it fit, in the order they were dropped. */
  dropped: string[];
  /** Bullet ids switched back on to use the room that was left over. */
  added: string[];
  /** Project entry ids switched off entirely. */
  droppedEntries: string[];
  /** Whether it fits now. False means it is as small as this will make it. */
  fits: boolean;
}

/** Bullets still switched on for an entry, in the model's own order. */
function keptBullets(entry: PlannedEntry) {
  return entry.bullets.filter((b) => b.include).sort((a, b) => a.order - b.order);
}

/**
 * How much of a project's own vocabulary the posting also uses.
 *
 * A proportion, not a count, so a wordy project does not outrank a terse one
 * that is squarely on topic. Ordinary English is excluded — matching on "built"
 * and "with" would rank every entry the same, which is how a naive overlap
 * score fails.
 */
function relevanceTo(jdLexicon: Set<string>, name: string, bulletText: string): number {
  const terms = new Set<string>();
  for (const t of tokenize(`${name} ${bulletText}`)) {
    if (t.norm.length < 3 || isCommonSentenceOpener(t.norm)) continue;
    terms.add(t.norm);
  }
  if (terms.size === 0) return 0;

  let hits = 0;
  for (const term of terms) if (jdLexicon.has(term)) hits++;
  return hits / terms.size;
}

/** Project ids, least relevant first. Ties keep the profile's own order. */
function projectsByRelevance(plan: TailorPlan, profile: Profile, jdText: string): string[] {
  const jdLexicon = buildLexicon(jdText);
  const byId = new Map(profile.projects.map((p) => [p.id, p]));

  return plan.projects
    .map((e, i) => {
      const source = byId.get(e.id);
      const score = source
        ? relevanceTo(jdLexicon, source.name, source.bullets.map((b) => b.text).join(' '))
        : 0;
      return { id: e.id, score, i };
    })
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.id);
}

/**
 * The next thing to give up, or null when there is nothing left worth taking.
 *
 * Returns the *last* bullet of the chosen entry: the model put it last, so it
 * is the one the model thought least of.
 */
/**
 * Bullets the best-matching project keeps before roles start paying instead.
 *
 * One line is a stub; three is a section. Two says what the thing is and that
 * it was real, which is what a nice-to-have on a posting is worth.
 */
const PROTECTED_PROJECT_BULLETS = 2;

/**
 * How much of a project's vocabulary the posting must share before it is worth
 * overriding the model to put it back.
 *
 * Deliberately a real bar. This is a floor under relevance, not a second
 * opinion on the model's judgement: below it, the model dropping the project
 * was almost certainly right, and putting things back on a weak signal would
 * make the resume worse in exactly the way a keyword-stuffer does.
 */
const REINSTATE_THRESHOLD = 0.12;

/**
 * Skill groups a resume keeps whatever else has to go.
 *
 * A skills section stripped to one line reads as an omission rather than as
 * focus, and the groups are ranked, so the two that survive are the two the
 * posting cares about most.
 */
const MIN_SKILL_GROUPS = 2;

/**
 * The next thing to give up, or null when there is nothing left worth taking.
 *
 * Returns the *last* bullet of the chosen entry: the model put it last, so it
 * is the one the model thought least of.
 *
 * Order of preference, and the reason for each:
 *
 *   1. Projects the posting did not ask about. Cheapest thing on the page.
 *   2. Role bullets — but only once the best project is down to a line or two,
 *      so a relevant library is not sacrificed to keep a fourth bullet on a job
 *      the reader can already see three of.
 *   3. The best project after all, if roles have nothing left to give.
 */
function nextCut(
  plan: TailorPlan,
  profile: Profile,
  ranking: string[] | null,
): { entry: PlannedEntry; bulletId: string; kind: 'project' | 'work' } | null {
  const live = plan.projects.filter((e) => e.include && keptBullets(e).length > 0);

  const take = (entry: PlannedEntry, kind: 'project' | 'work') => {
    const bullets = keptBullets(entry);
    return { entry, bulletId: bullets[bullets.length - 1]!.bulletId, kind };
  };

  // Least relevant first; without a posting, the one with most to spare.
  const order = ranking ? new Map(ranking.map((id, i) => [id, i])) : null;
  const byPreference = [...live].sort((a, b) =>
    order
      ? (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
      : keptBullets(b).length - keptBullets(a).length,
  );

  // The most relevant project is the last one the ranking would reach.
  const best = order && byPreference.length ? byPreference[byPreference.length - 1] : null;
  const unprotected = byPreference.filter(
    (e) => e !== best || keptBullets(e).length > PROTECTED_PROJECT_BULLETS,
  );

  if (unprotected.length) return take(unprotected[0]!, 'project');

  // Oldest first: recent work is what a reader weighs, and the oldest role
  // carrying five bullets is the least defensible use of a page.
  const seniority = new Map(profile.work.map((w, i) => [w.id, i]));
  const roles = plan.work
    .filter((e) => e.include && keptBullets(e).length > 1)
    .sort((a, b) => {
      const byCount = keptBullets(b).length - keptBullets(a).length;
      return byCount !== 0 ? byCount : (seniority.get(b.id) ?? 0) - (seniority.get(a.id) ?? 0);
    });

  if (roles[0]) return take(roles[0], 'work');

  // Nothing left but the project we were holding back. A resume that does not
  // fit is worse than one without a projects section.
  return live.length ? take(byPreference[byPreference.length - 1]!, 'project') : null;
}

/**
 * Trims a plan until the document it produces fits the page target.
 *
 * Pure: takes a plan, returns a new one. The caller decides whether to use it,
 * and the user still reviews every change it made.
 */
export function fitToTarget(
  profile: Profile,
  plan: TailorPlan,
  pageTarget: 1 | 2,
  template?: PageMetrics,
  /** The posting, so projects can be ranked by what it actually asked for. */
  jdText?: string,
): FitResult {
  const metrics = template ?? DEFAULT_METRICS;
  const budget = pageHeight(metrics) * pageTarget - SAFETY_POINTS;

  // Structured clone would drop nothing here, but the plan is plain data and
  // callers should not find their input mutated underneath them.
  let next: TailorPlan = JSON.parse(JSON.stringify(plan));
  const dropped: string[] = [];
  const droppedEntries: string[] = [];
  const ranking = jdText?.trim() ? projectsByRelevance(plan, profile, jdText) : null;

  // The ranking can only order what the plan kept. Across runs of one profile
  // against one posting the model sometimes kept `react-native-island` and
  // sometimes did not, and when it did not, a posting asking for published
  // React Native libraries produced a resume with no projects — from a profile
  // containing exactly that.
  //
  // So one may be put back: the best match, only if it is a real match, and
  // only if the page turns out to hold it. The trim runs afterwards and will
  // take it out again if it does not fit, so this cannot push the resume over.
  //
  // The condition is "the best match is not in", not "nothing is in". The model
  // kept `Revento` and dropped `react-native-island`, so a projects section
  // existed and the better match was never considered — and a section
  // containing *a* project is not the same as one containing the right one. The
  // weaker entry then ranks lowest and the trim takes it first.
  let reinstated: string | null = null;
  if (ranking && !next.projects.find((e) => e.id === ranking[ranking.length - 1])?.include) {
    const best = ranking[ranking.length - 1];
    const entry = best ? next.projects.find((e) => e.id === best) : undefined;
    const source = best ? profile.projects.find((pr) => pr.id === best) : undefined;

    if (entry && source) {
      const score = relevanceTo(
        buildLexicon(jdText!),
        source.name,
        source.bullets.map((b) => b.text).join(' '),
      );
      if (score >= REINSTATE_THRESHOLD) {
        entry.include = true;
        // Its own best lines, in the order the model gave them.
        for (const b of [...entry.bullets].sort((a, c) => a.order - c.order).slice(0, PROTECTED_PROJECT_BULLETS)) {
          b.include = true;
        }
        reinstated = entry.id;
      }
    }
  }

  // A project the plan kept but emptied is a heading, a date range and nothing
  // else. The model does return these — one run shipped a PROJECTS section
  // containing only "Revento (Full Stack Application), 10/2019 — Present" —
  // and the trim would never have looked at it, because it only considers
  // entries that still have bullets to take.
  //
  // Roles are different: a role with no bullets still says the person was
  // employed, and taking it out opens a gap in the timeline.
  for (const entry of next.projects) {
    if (entry.include && entry.bullets.every((b) => !b.include)) {
      entry.include = false;
      droppedEntries.push(entry.id);
    }
  }

  // A kept role, on the other hand, has to say something. CIMx rendered as a
  // job title, an employer and a date range with nothing under it, because the
  // model included the entry and excluded every one of its bullets — and the
  // trim will not take a role's last bullet, so nothing put one back.
  //
  // Keeping the heading and restoring a line are not in tension: the timeline
  // stays intact and the entry stops reading as padding. The bullet is the one
  // the model ranked first, and the trim runs afterwards, so the space is paid
  // for somewhere it matters less.
  //
  // Only for a role the plan *kept*. Excluding an entry is a decision;
  // emptying one is an oversight.
  for (const entry of next.work) {
    if (!entry.include || entry.bullets.some((b) => b.include)) continue;
    const first = [...entry.bullets].sort((a, b) => a.order - b.order)[0];
    if (first) first.include = true;
  }

  // Changes, not an empty array. `buildDocument` only honours a drop once the
  // corresponding change is accepted, so measuring against `[]` renders the
  // document as though nothing had been cut — which is how the first version of
  // this trimmed twenty bullets and reported no improvement at all.
  // `buildChanges` marks everything accepted, which is the state the user
  // reaches with "Accept all".
  const heightNow = () =>
    estimateHeight(buildDocument(profile, next, buildChanges(profile, next)), metrics);
  const overflows = () => heightNow() > budget;

  // Skills before the protected project. Roles down to a bullet each still left
  // the page overflowing while six skill groups took eleven lines, two of them
  // naming nothing the posting had asked for — and the project the posting *had*
  // asked for was sacrificed to keep them. A group nobody reads is the cheapest
  // thing on a resume to lose.
  if (ranking) {
    const jdLexicon = buildLexicon(jdText!);
    const scored = next.skills
      .filter((g) => g.include)
      .map((g) => ({ g, score: relevanceTo(jdLexicon, '', g.keywords.join(' ')) }))
      .sort((a, b) => a.score - b.score);

    for (const { g } of scored) {
      if (!overflows()) break;
      if (next.skills.filter((x) => x.include).length <= MIN_SKILL_GROUPS) break;
      g.include = false;
    }
  }

  // Bounded by the number of bullets, and every iteration switches one off, so
  // this terminates. The guard is against a bug in `nextCut`, not against the
  // data.
  const limit = plan.work.concat(plan.projects).reduce((n, e) => n + e.bullets.length, 0) + 1;

  for (let i = 0; i < limit && overflows(); i++) {
    const cut = nextCut(next, profile, ranking);
    if (!cut) break;

    for (const b of cut.entry.bullets) {
      if (b.bulletId === cut.bulletId) b.include = false;
    }
    dropped.push(cut.bulletId);

    // A project reduced to one line is three lines of page — heading, dates
    // and the bullet — for something the reader will not remember. Take the
    // whole entry rather than leave it as a stub.
    if (cut.kind === 'project' && keptBullets(cut.entry).length <= 1) {
      for (const b of cut.entry.bullets) b.include = false;
      cut.entry.include = false;
      droppedEntries.push(cut.entry.id);
    }
  }

  // If it could not be kept after all, say so rather than reporting a change
  // the document does not show.
  const stillThere = reinstated
    ? (next.projects.find((e) => e.id === reinstated)?.include ?? false)
    : false;

  // Fitting a page and using a page are not the same thing. The trim only ever
  // removed, so an over-cautious plan — or a cut that overshot — left one
  // bullet per role and a fifth of the page blank, which reads as though there
  // was nothing to say.
  //
  // Growing back is the same kind of change in the other direction: bullets are
  // switched on, they are the person's own, they are the model's next choices
  // rather than arbitrary ones, and the review screen shows every one.
  const added: string[] = [];
  for (let i = 0; i < limit; i++) {
    // The entry with the least to show goes first, so the page fills evenly
    // instead of stacking everything onto the newest role. Roles before
    // projects: employment is what a reader weighs.
    const candidates = [...next.work, ...next.projects]
      .filter((e) => e.include && e.bullets.some((b) => !b.include))
      .sort((a, b) => keptBullets(a).length - keptBullets(b).length);

    const entry = candidates[0];
    if (!entry) break;

    const nextBullet = [...entry.bullets]
      .filter((b) => !b.include)
      .sort((a, b) => a.order - b.order)[0];
    if (!nextBullet) break;

    nextBullet.include = true;
    if (overflows()) {
      // Put it back and stop: anything further would only overflow too.
      nextBullet.include = false;
      break;
    }
    added.push(nextBullet.bulletId);
  }

  return {
    plan: next,
    reinstated: stillThere ? reinstated : null,
    dropped,
    added,
    droppedEntries,
    // Against the page itself, not the trim budget — growth deliberately fills
    // past that, so measuring against it would report a full page as a failure.
    fits: heightNow() <= pageHeight(metrics) * pageTarget,
  };
}
