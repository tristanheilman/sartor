import type { Profile } from '../schema';
import { buildChanges, buildDocument } from './apply';
import { estimateLines, linesPerPage } from '../render/model';
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
 *   1. Project bullets, from the project with the most, working up.
 *   2. Whole projects, once one is down to a single bullet — a heading and one
 *      line costs three lines to say almost nothing.
 *   3. Role bullets, from the oldest role with the most, working up.
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

/** A page's worth of lines in the default template, when none is given. */
const DEFAULT_LINES_PER_PAGE = 50;

/**
 * Lines held back from the target, because the estimate is an estimate.
 *
 * `estimateLines` counts wrapped text and charges a flat two lines per section
 * and per entry; the renderer then adds real leading, section rules and — since
 * headings refuse to be stranded — sometimes moves a whole section rather than
 * split it. A document measured at exactly one page came out as one page plus
 * a single education entry, seventy characters alone on page two.
 *
 * Five lines is about a heading and an entry: enough that the arithmetic being
 * a little optimistic does not cost a whole extra sheet of paper, small enough
 * that it does not throw away content for nothing.
 */
const SAFETY_LINES = 5;

export interface FitResult {
  plan: TailorPlan;
  /** Bullet ids switched off to make it fit, in the order they were dropped. */
  dropped: string[];
  /** Project entry ids switched off entirely. */
  droppedEntries: string[];
  /** Whether it fits now. False means it is as small as this will make it. */
  fits: boolean;
}

interface PageMetrics {
  baseSize: number;
  lineHeight: number;
  pageMargin: number;
}

/** Bullets still switched on for an entry, in the model's own order. */
function keptBullets(entry: PlannedEntry) {
  return entry.bullets.filter((b) => b.include).sort((a, b) => a.order - b.order);
}

/**
 * The next thing to give up, or null when there is nothing left worth taking.
 *
 * Returns the *last* bullet of the chosen entry: the model put it last, so it
 * is the one the model thought least of.
 */
function nextCut(
  plan: TailorPlan,
  profile: Profile,
): { entry: PlannedEntry; bulletId: string; kind: 'project' | 'work' } | null {
  const projects = plan.projects.filter((e) => e.include && keptBullets(e).length > 0);
  if (projects.length) {
    // The fattest project first, so the cuts land where there is most to spare
    // rather than hollowing out one entry at a time.
    const fattest = projects.sort((a, b) => keptBullets(b).length - keptBullets(a).length)[0]!;
    const bullets = keptBullets(fattest);
    return { entry: fattest, bulletId: bullets[bullets.length - 1]!.bulletId, kind: 'project' };
  }

  // Oldest first: recent work is what a reader weighs, and the oldest role
  // carrying five bullets is the least defensible use of a page.
  const order = new Map(profile.work.map((w, i) => [w.id, i]));
  const roles = plan.work
    .filter((e) => e.include && keptBullets(e).length > 1)
    .sort((a, b) => {
      const byCount = keptBullets(b).length - keptBullets(a).length;
      return byCount !== 0 ? byCount : (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0);
    });

  const role = roles[0];
  if (!role) return null;
  const bullets = keptBullets(role);
  return { entry: role, bulletId: bullets[bullets.length - 1]!.bulletId, kind: 'work' };
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
): FitResult {
  const perPage = template ? linesPerPage(template) : DEFAULT_LINES_PER_PAGE;
  const budget = perPage * pageTarget - SAFETY_LINES;

  // Structured clone would drop nothing here, but the plan is plain data and
  // callers should not find their input mutated underneath them.
  let next: TailorPlan = JSON.parse(JSON.stringify(plan));
  const dropped: string[] = [];
  const droppedEntries: string[] = [];

  // Changes, not an empty array. `buildDocument` only honours a drop once the
  // corresponding change is accepted, so measuring against `[]` renders the
  // document as though nothing had been cut — which is how the first version of
  // this trimmed twenty bullets and reported no improvement at all.
  // `buildChanges` marks everything accepted, which is the state the user
  // reaches with "Accept all".
  const overflows = () =>
    estimateLines(buildDocument(profile, next, buildChanges(profile, next))) > budget;

  // Bounded by the number of bullets, and every iteration switches one off, so
  // this terminates. The guard is against a bug in `nextCut`, not against the
  // data.
  const limit = plan.work.concat(plan.projects).reduce((n, e) => n + e.bullets.length, 0) + 1;

  for (let i = 0; i < limit && overflows(); i++) {
    const cut = nextCut(next, profile);
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

  return { plan: next, dropped, droppedEntries, fits: !overflows() };
}
