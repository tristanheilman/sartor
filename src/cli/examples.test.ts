import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './main';
import type { Io } from './io';
import { profileSchema } from '../core/schema';
import { tailorPlanSchema } from '../core/tailor/plan';
import { validatePlan } from '../core/tailor/run';

/**
 * The sample in `examples/` is what a newcomer runs first and what the CLI and
 * the plugin are tested against by hand. Nothing else in the suite reads it,
 * so without this it would drift from the schemas the first time one changed
 * and nobody would notice until a demo failed.
 *
 * Driven through `main` in-process, the way `cli.test.ts` does, so the
 * walkthrough in `examples/README.md` is exercised end to end: the prompt,
 * the plan applied and fitted, the guard, and a rendered resume.
 */

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '../../examples');
const profile = join(EXAMPLES, 'profile.json');
const posting = join(EXAMPLES, 'posting.txt');
const plan = join(EXAMPLES, 'plan.json');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'sartor-examples-'));
});

async function sartor(args: string[]): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: { write: (s: string) => (stdout += s), isTTY: false },
    stderr: { write: (s: string) => (stderr += s) },
    stdin: Object.assign((async function* () {})(), { isTTY: true }),
    cwd,
    // No key, deliberately: the walkthrough promises to run without one.
    env: {},
  };
  const code = await main(args, io, '0.0.0-test');
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { code, stdout, stderr, json };
}

describe('the sample in examples/', () => {
  it('has a profile that matches the profile schema', () => {
    const parsed = profileSchema.parse(JSON.parse(readFileSync(profile, 'utf8')));
    expect(parsed.basics.name).toBe('Avery Lindqvist');
    expect(parsed.work.length).toBeGreaterThanOrEqual(3);
    expect(parsed.projects.length).toBeGreaterThanOrEqual(2);
    expect(parsed.skills.length).toBeGreaterThanOrEqual(3);
  });

  it('has a plan that matches the plan schema and points only at the profile', () => {
    const parsedProfile = profileSchema.parse(JSON.parse(readFileSync(profile, 'utf8')));
    const parsedPlan = tailorPlanSchema.parse(JSON.parse(readFileSync(plan, 'utf8')));
    // Every id the plan names has to exist, or the pipeline silently drops it
    // and the demo shows less than the file says it does.
    expect(validatePlan(parsedPlan, parsedProfile).dropped).toEqual([]);
    expect(parsedPlan.requested).toContain('prj_formlift');
  });

  it('writes the prompt with no API key', async () => {
    const r = await sartor(['tailor', 'prompt', '--profile', profile, '--posting', posting, '--pages', '1', '--out', 'tailor-prompt.json']);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(join(cwd, 'tailor-prompt.json'), 'utf8'));
    expect(written.input).toMatch(/Avery Lindqvist/);
    expect(written.input).toMatch(/Lumen Fieldwork/);
  });

  it('applies the plan, fits one page and renders text and a PDF', async () => {
    const applied = await sartor(['tailor', 'apply', '--profile', profile, '--posting', posting, '--plan', plan, '--pages', '1', '--out', 'run.json']);
    expect(applied.code).toBe(0);
    expect(applied.json.data.estimate).toMatchObject({ pages: 1, fits: true });
    // The plan's summary uses only what the profile has, so nothing blocks.
    expect(applied.json.data.changes.blocking).toBe(0);
    expect((applied.json.warnings ?? []).join(' ')).not.toMatch(/not in your profile/);
    expect(applied.json.data.notes).toMatch(/GraphQL/);

    const txt = await sartor(['render', 'run.json', '--format', 'txt', '--out', 'resume.txt']);
    expect(txt.code).toBe(0);
    const text = readFileSync(join(cwd, 'resume.txt'), 'utf8');
    expect(text).toMatch(/Avery Lindqvist/);
    expect(text).toMatch(/Tidewater Health/);
    // The library the posting asked for survives the fit.
    expect(text).toMatch(/formlift/);
    // And the gaps are left as gaps.
    expect(text).not.toMatch(/GraphQL|Kubernetes|Rust/);

    const pdf = await sartor(['render', 'run.json', '--format', 'pdf', '--out', 'resume.pdf']);
    expect(pdf.code).toBe(0);
    expect(pdf.json.data).toMatchObject({ pages: 1, pageTarget: 1 });
  });

  it('reports the posting terms the profile cannot support', async () => {
    await sartor(['tailor', 'apply', '--profile', profile, '--posting', posting, '--plan', plan, '--pages', '1', '--out', 'run.json']);
    const check = await sartor(['check', 'run.json']);
    expect(check.code).toBe(0);
    expect(check.json.data.coverage.notInProfile).toEqual(expect.arrayContaining(['GraphQL', 'Kubernetes']));
  });
});
