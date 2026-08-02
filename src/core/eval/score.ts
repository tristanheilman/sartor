import type { Profile } from '../schema';
import type { TailorPlan } from '../tailor/plan';
import { validatePlan } from '../tailor/run';
import { buildChanges, buildDocument } from '../tailor/apply';
import { checkText, profileLexicon } from '../tailor/guard';
import { buildCoverage } from '../tailor/coverage';
import { documentToSlices, documentToText, estimateLines, LINES_PER_PAGE } from '../render/model';
import { parseSafetyChecks, worstStatus } from '../render/parseSafety';
import type { ResumeDocument } from '../render/model';

/**
 * Scoring a tailoring run against a gold-standard case.
 *
 * "Is this a good resume?" is not answerable. "Did the pipeline keep the four
 * bullets a human said were essential, drop the one that was a trap, fit the
 * page, and invent nothing?" is — and because the plan is IDs rather than
 * prose, most of it reduces to set membership.
 *
 * Two kinds of result, and the distinction is load-bearing:
 *
 *   - **Gates** are pass/fail and never negotiable. A fabricated employer is
 *     not a low score, it is a broken build.
 *   - **Scores** are 0–1 and exist to be compared against a committed baseline,
 *     so a prompt change shows up as a delta rather than a feeling.
 *
 * These numbers are for the repository, not for users. `coverage.ts` refuses to
 * show anyone a 0-100 resume score, for good reasons that still hold; what is
 * different here is the question. We are not telling a candidate how good their
 * resume is, we are asking whether version N+1 of our own selector is better
 * than version N on cases where we already know the answer.
 */

export interface EvalCase {
  name: string;
  /** Why this case exists and what it is trying to catch. */
  intent: string;
  profile: Profile;
  posting: string;
  pageTarget: 1 | 2;
  /** Bullet IDs a competent human would keep. Recall is measured against these. */
  mustInclude: string[];
  /** Bullet IDs that would be padding or noise for this posting. */
  mustExclude: string[];
  /**
   * Strings that must appear nowhere in the output. Fabrication traps: a term
   * the posting demands and the profile does not have, which the model will be
   * tempted to supply.
   */
  forbidden: string[];
}

export interface Gate {
  name: string;
  passed: boolean;
  detail: string;
}

export interface EvalScores {
  /** Fraction of `mustInclude` bullets that survived into the document. */
  recall: number;
  /**
   * Of the posting's emphasised requirements the profile can actually support,
   * the fraction the selector surfaced. Terms the user does not have are
   * excluded — failing to show evidence that does not exist is not a miss.
   */
  requirementCoverage: number;
  estimatedLines: number;
  lineBudget: number;
}

export interface EvalResult {
  name: string;
  passed: boolean;
  gates: Gate[];
  scores: EvalScores;
  /** Built for the caller so slower checks (rendering) need not rebuild it. */
  doc: ResumeDocument;
}

const ratio = (hit: number, total: number) => (total === 0 ? 1 : hit / total);

/** Every bullet ID that made it into the rendered document. */
function includedBulletIds(plan: TailorPlan): Set<string> {
  const ids = new Set<string>();
  for (const section of [plan.work, plan.projects, plan.education]) {
    for (const entry of section) {
      if (!entry.include) continue;
      for (const b of entry.bullets) if (b.include) ids.add(b.bulletId);
    }
  }
  return ids;
}

export function scorePlan(testCase: EvalCase, rawPlan: TailorPlan): EvalResult {
  const { profile, posting, pageTarget } = testCase;

  // Exactly the path the application takes. An eval that reimplements the
  // pipeline is testing the reimplementation.
  const plan = validatePlan(rawPlan, profile).plan;
  const changes = buildChanges(profile, plan);
  const doc = buildDocument(profile, plan, changes);

  const text = documentToText(doc);
  const lower = text.toLowerCase();
  const included = includedBulletIds(plan);

  const gates: Gate[] = [];

  // --- Gate: nothing invented ------------------------------------------
  const lexicon = profileLexicon(profile);
  const highSeverity = checkText(text, lexicon, 'document').violations.filter(
    (v) => v.severity === 'high',
  );
  gates.push({
    name: 'no-fabrication',
    passed: highSeverity.length === 0,
    detail: highSeverity.length
      ? `ungrounded: ${highSeverity.map((v) => v.token).join(', ')}`
      : 'every proper noun and number traces to the profile',
  });

  // --- Gate: did not take the bait -------------------------------------
  const tookBait = testCase.forbidden.filter((f) => lower.includes(f.toLowerCase()));
  gates.push({
    name: 'no-forbidden-terms',
    passed: tookBait.length === 0,
    detail: tookBait.length ? `claimed: ${tookBait.join(', ')}` : 'claimed nothing the profile lacks',
  });

  // --- Gate: no padding -------------------------------------------------
  const padding = testCase.mustExclude.filter((id) => included.has(id));
  gates.push({
    name: 'no-padding',
    passed: padding.length === 0,
    detail: padding.length ? `included irrelevant: ${padding.join(', ')}` : 'kept the noise out',
  });

  // --- Gate: fits the page ---------------------------------------------
  const estimatedLines = estimateLines(doc);
  const lineBudget = LINES_PER_PAGE * pageTarget;
  gates.push({
    name: 'fits-page-target',
    passed: estimatedLines <= lineBudget,
    detail: `${estimatedLines} of ${lineBudget} lines`,
  });

  // --- Gate: structurally parseable ------------------------------------
  const checks = parseSafetyChecks(doc, pageTarget);
  const worst = worstStatus(checks);
  gates.push({
    name: 'parse-safety',
    passed: worst !== 'fail',
    detail:
      worst === 'fail'
        ? checks.filter((c) => c.status === 'fail').map((c) => c.label).join('; ')
        : `worst check: ${worst}`,
  });

  // --- Scores ------------------------------------------------------------
  const keptEssential = testCase.mustInclude.filter((id) => included.has(id));

  const coverage = buildCoverage(posting, documentToSlices(doc), profile);
  const supportable = coverage.terms.filter((t) => t.emphasised && t.status !== 'missing');
  const surfaced = supportable.filter((t) => t.status === 'present');

  return {
    name: testCase.name,
    passed: gates.every((g) => g.passed),
    gates,
    scores: {
      recall: ratio(keptEssential.length, testCase.mustInclude.length),
      requirementCoverage: ratio(surfaced.length, supportable.length),
      estimatedLines,
      lineBudget,
    },
    doc,
  };
}

/* ------------------------------------------------------------------ *
 * Stability across repeated runs
 * ------------------------------------------------------------------ */

export interface Spread {
  mean: number;
  min: number;
  max: number;
}

export interface CaseResult {
  name: string;
  /** True only if every gate held on every recording. */
  passed: boolean;
  runs: EvalResult[];
  recall: Spread;
  requirementCoverage: Spread;
  /**
   * How much the recordings agree on *what to include*, 0–1.
   *
   * This is the number that matters most, and the one nothing else measures.
   * A case can score 1.00 recall on average while two runs produce visibly
   * different resumes — we measured exactly that: identical profile and
   * posting, one run keeping both employers and another dropping one. Mean
   * scores hide it; this does not.
   *
   * 1.00 means every recording chose the same bullets. Anything much below
   * that means a prompt change cannot be evaluated, because the dice move the
   * output further than the edit does.
   */
  selectionAgreement: number;
}

function spread(values: number[]): Spread {
  if (!values.length) return { mean: 0, min: 0, max: 0 };
  return {
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/** Mean pairwise Jaccard over the sets of bullets each run chose to include. */
function agreement(runs: EvalResult[]): number {
  if (runs.length < 2) return 1;

  const sets = runs.map(
    (r) =>
      new Set(
        r.doc.sections.flatMap((s) => s.entries ?? []).flatMap((e) => e.bullets.map((b) => b.sourceId)),
      ),
  );

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i] as Set<string>;
      const b = sets[j] as Set<string>;
      let shared = 0;
      for (const v of a) if (b.has(v)) shared++;
      const union = a.size + b.size - shared;
      total += union === 0 ? 1 : shared / union;
      pairs++;
    }
  }
  return pairs ? total / pairs : 1;
}

/**
 * Scores every recording of a case together.
 *
 * A gate that holds four times out of five has not held. Passing requires all
 * of them, and the report names the run that broke — an intermittent failure
 * you cannot locate is worse than a consistent one.
 */
export function scoreCase(testCase: EvalCase, plans: TailorPlan[]): CaseResult {
  const runs = plans.map((plan) => scorePlan(testCase, plan));

  return {
    name: testCase.name,
    passed: runs.every((r) => r.passed),
    runs,
    recall: spread(runs.map((r) => r.scores.recall)),
    requirementCoverage: spread(runs.map((r) => r.scores.requirementCoverage)),
    selectionAgreement: agreement(runs),
  };
}

/* ------------------------------------------------------------------ *
 * Baselines
 * ------------------------------------------------------------------ */

export interface Baseline {
  [caseName: string]: {
    recall: number;
    requirementCoverage: number;
    /** Instability is itself a regression: see `CaseResult.selectionAgreement`. */
    selectionAgreement: number;
  };
}

export interface Drift {
  name: string;
  metric: string;
  before: number;
  after: number;
  regressed: boolean;
}

/**
 * How far a run has moved from the committed baseline.
 *
 * `tolerance` absorbs the noise of re-recording; anything worse than that is a
 * regression the author has to look at and either fix or accept by updating the
 * baseline in the same commit. That is the whole iteration loop: change the
 * prompt, see the delta, decide.
 *
 * `selectionAgreement` is compared like any other metric, so a change that
 * makes the selector *less* consistent fails even if the mean scores hold.
 */
export function compareToBaseline(results: CaseResult[], baseline: Baseline, tolerance = 0.02): Drift[] {
  const out: Drift[] = [];

  for (const result of results) {
    const previous = baseline[result.name];
    if (!previous) continue;

    const current: Record<string, number> = {
      recall: result.recall.mean,
      requirementCoverage: result.requirementCoverage.mean,
      selectionAgreement: result.selectionAgreement,
    };

    for (const [metric, after] of Object.entries(current)) {
      const before = previous[metric as keyof typeof previous];
      if (before === undefined || before === after) continue;
      out.push({ name: result.name, metric, before, after, regressed: after < before - tolerance });
    }
  }

  return out;
}

/** The baseline this run would write, for pasting into `evals/baseline.json`. */
export function toBaseline(results: CaseResult[]): Baseline {
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return Object.fromEntries(
    results.map((r) => [
      r.name,
      {
        recall: round(r.recall.mean),
        requirementCoverage: round(r.requirementCoverage.mean),
        selectionAgreement: round(r.selectionAgreement),
      },
    ]),
  );
}

/** A fixed-width table, for the terminal and for pasting into a PR. */
export function formatReport(results: CaseResult[]): string {
  const range = (s: Spread) =>
    s.min === s.max ? s.mean.toFixed(2) : `${s.mean.toFixed(2)} (${s.min.toFixed(2)}-${s.max.toFixed(2)})`;

  const lines = [
    'case                      runs  pass  agree  recall             reqs',
    '------------------------  ----  ----  -----  -----------------  -----------------',
  ];

  for (const r of results) {
    lines.push(
      [
        r.name.padEnd(24),
        String(r.runs.length).padStart(4),
        (r.passed ? ' ok ' : 'FAIL').padEnd(4),
        r.selectionAgreement.toFixed(2).padStart(5),
        range(r.recall).padStart(17),
        range(r.requirementCoverage).padStart(17),
      ].join('  '),
    );

    // Name the run that broke. An intermittent failure you cannot locate is
    // worse than a consistent one.
    r.runs.forEach((run, i) => {
      for (const gate of run.gates.filter((g) => !g.passed)) {
        lines.push(`    run ${i + 1}: \u2717 ${gate.name} \u2014 ${gate.detail}`);
      }
    });

    if (r.selectionAgreement < 0.85 && r.runs.length > 1) {
      lines.push(
        `    note: recordings agree on only ${(r.selectionAgreement * 100).toFixed(0)}% of included bullets \u2014 prompt changes are hard to evaluate at this spread`,
      );
    }
  }

  return lines.join('\n');
}
