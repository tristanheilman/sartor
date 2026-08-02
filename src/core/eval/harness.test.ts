import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { profileSchema } from '../schema';
import { tailorPlanSchema } from '../tailor/plan';
import { renderPdfBlob } from '../render/pdf';
import { extractResumeText } from '../parse/extract';
import { documentToText } from '../render/model';
import {
  compareToBaseline,
  formatReport,
  scoreCase,
  toBaseline,
  type Baseline,
  type CaseResult,
  type EvalCase,
} from './score';

/**
 * End-to-end evals against gold-standard cases.
 *
 * Each case in `evals/cases/` is a profile, a real-shaped job posting, a
 * recorded model plan, and a human's labels for what a good answer looks like.
 * The whole pipeline runs — validate, change-build, document-build, guard,
 * coverage, render — and the result is measured against those labels.
 *
 * **No network.** The recorded plan is the cassette. Everything downstream of
 * the model call is pure, so replaying a plan exercises the entire pipeline
 * deterministically, for free, on every PR. Re-recording a plan against a live
 * provider is a separate, deliberate act — see `evals/README.md`.
 */

const EVALS = join(dirname(fileURLToPath(import.meta.url)), '../../../evals');
const CASES = join(EVALS, 'cases');

const pdfWorkerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
).href;

beforeAll(() => {
  globalThis.DOMMatrix ??= class {} as unknown as typeof DOMMatrix;
});

/**
 * A case's recorded plans.
 *
 * Several, because the model is not deterministic: the same profile and posting
 * produced one resume keeping both employers and another dropping one. A single
 * recording would pin one roll of the dice and call it the behaviour.
 *
 * They are replayed, not re-requested, so sampling the variance costs nothing
 * per run — it was paid once, at record time, by `npm run audit -- --repeat k`.
 */
function loadPlans(dir: string): ReturnType<typeof tailorPlanSchema.parse>[] {
  const plansDir = join(dir, 'plans');
  const files = existsSync(plansDir)
    ? readdirSync(plansDir).filter((f) => f.endsWith('.json')).sort()
    : [];

  const sources = files.length
    ? files.map((f) => join(plansDir, f))
    : [join(dir, 'plan.json')]; // a single recording is still a valid case

  return sources.map((p) => tailorPlanSchema.parse(JSON.parse(readFileSync(p, 'utf8'))));
}

function loadCase(name: string): {
  testCase: EvalCase;
  plans: ReturnType<typeof tailorPlanSchema.parse>[];
  /** Gate name -> why it is known to fail. See the assertion below. */
  knownFailures: Record<string, string>;
} {
  const dir = join(CASES, name);
  const json = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
  const labels = json('labels.json');

  return {
    testCase: {
      name,
      intent: String(labels.intent),
      profile: profileSchema.parse(json('profile.json')),
      posting: readFileSync(join(dir, 'posting.txt'), 'utf8'),
      pageTarget: labels.pageTarget as 1 | 2,
      mustInclude: labels.mustInclude as string[],
      mustExclude: labels.mustExclude as string[],
      mustKeepEntries: (labels.mustKeepEntries ?? []) as string[],
      forbidden: labels.forbidden as string[],
      knownFailures: (labels.knownFailures ?? {}) as Record<string, string>,
    },
    plans: loadPlans(dir),
    knownFailures: (labels.knownFailures ?? {}) as Record<string, string>,
  };
}

const caseNames = readdirSync(CASES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

const results: CaseResult[] = [];

describe('gold-standard cases', () => {
  it('has cases to run', () => {
    expect(caseNames.length).toBeGreaterThan(0);
  });

  describe.each(caseNames)('%s', (name) => {
    const { testCase, plans, knownFailures } = loadCase(name);
    const result = scoreCase(testCase, plans);
    results.push(result);

    // Every gate, on every recording. A gate that holds four times out of
    // five has not held, and the label names the run so an intermittent
    // failure can be located.
    //
    // A gate listed in `knownFailures` is a defect we have measured and cannot
    // fix yet. Rather than tolerate it silently, the assertion inverts: it
    // requires the gate to still be failing somewhere. The day a change fixes
    // it, this test goes red and whoever fixed it deletes the marker — so a
    // known defect can never quietly become an unnoticed one.
    const gateNames = [...new Set(result.runs.flatMap((r) => r.gates.map((g) => g.name)))];

    it.each(gateNames)('%s', (gateName) => {
      const outcomes = result.runs.map((run, i) => ({
        run: i + 1,
        gate: run.gates.find((g) => g.name === gateName)!,
      }));
      const failed = outcomes.filter((o) => !o.gate.passed);
      const known = knownFailures[gateName];

      if (known) {
        expect(
          failed.length,
          `"${gateName}" is marked as known-failing (${known}) but now passes on every run — delete it from knownFailures in labels.json`,
        ).toBeGreaterThan(0);
        return;
      }

      expect(
        failed.map((o) => `run ${o.run}: ${o.gate.detail}`),
        `${gateName} failed`,
      ).toEqual([]);
    });

    it('keeps the essential bullets in every run', () => {
      expect(result.recall.min, testCase.intent).toBe(1);
    });

    /**
     * The measurement that motivated all of this.
     *
     * Identical profile, identical posting, two live runs: one kept both
     * employers, the other dropped one. Mean recall was 1.00 for both. Until
     * this number is high, a prompt change cannot be told apart from a
     * different roll of the dice.
     */
    it('agrees with itself across recordings', () => {
      if (result.runs.length < 2) return;
      expect(
        result.selectionAgreement,
        `recordings agree on only ${(result.selectionAgreement * 100).toFixed(0)}% of included bullets`,
      ).toBeGreaterThanOrEqual(0.8);
    });

    /**
     * The closed loop, and the check no unit test can stand in for: render the
     * PDF this pipeline produces, then read it back with the same extractor
     * that ingests a user's resume. A document whose text does not survive that
     * round trip is unreadable to every downstream parser, however good it
     * looks on screen.
     *
     * Run on the first recording only — it is the slow check, and rendering is
     * deterministic given a document.
     */
    it('produces a PDF whose text can be read back out', async () => {
      const doc = result.runs[0]?.doc;
      if (!doc) throw new Error('no recordings');

      const blob = await renderPdfBlob(doc, 'classic');
      const file = new File([blob], `${name}.pdf`, { type: 'application/pdf' });

      const extracted = await extractResumeText(file, { pdfWorkerSrc });
      const flat = extracted.text.replace(/\s+/g, ' ');

      expect(extracted.kind).toBe('pdf');
      expect(flat).toContain(testCase.profile.basics.name);

      // Every bullet that made the cut has to come back out intact. Rendering
      // that silently drops or mangles a line is the failure mode here.
      for (const section of doc.sections) {
        for (const entry of section.entries ?? []) {
          for (const bullet of entry.bullets) {
            expect(flat).toContain(bullet.text.replace(/\s+/g, ' '));
          }
        }
      }
    });

    it('renders the same facts to text as to PDF', () => {
      for (const run of result.runs) {
        expect(documentToText(run.doc)).toContain(testCase.profile.basics.name);
      }
    });
  });
});

// The scores are the point of the exercise, so print them whether or not
// anything failed. `npm run eval` exists to show this table.
afterAll(() => {
  if (results.length) console.log(`\n${formatReport(results)}\n`);
});

describe('baseline', () => {
  const path = join(EVALS, 'baseline.json');

  it('has not regressed', () => {
    if (!existsSync(path)) {
      // Nothing to compare against yet. The author commits the printed numbers
      // as the new baseline rather than being blocked by their absence.
      console.log(
        `\nno baseline at ${path} — commit this:\n${JSON.stringify(toBaseline(results), null, 2)}`,
      );
      return;
    }

    const baseline = JSON.parse(readFileSync(path, 'utf8')) as Baseline;
    const drift = compareToBaseline(results, baseline);
    const regressions = drift.filter((d) => d.regressed);

    expect(
      regressions,
      regressions.map((r) => `${r.name}.${r.metric}: ${r.before} -> ${r.after}`).join('\n'),
    ).toEqual([]);
  });
});
