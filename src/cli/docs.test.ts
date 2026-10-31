import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, GLOBAL, main } from './main';
import { commandFor, commandsIn } from './doc-commands';
import type { Io } from './io';

/**
 * The README and the CLI reference are the public contract for `sartor`: an
 * agent reads them to learn the commands, and a person reads them to learn
 * the CLI exists at all. `skills.test.ts` already holds the plugin skills to
 * the commands they tell an agent to run; this file holds the two documents
 * everything else points at to the same standard, and goes one step further
 * for the one block meant to be followed verbatim — the README's agent
 * walkthrough is actually run, so a flag rename shows up as a failing test
 * rather than a broken copy-paste for whoever tries it next.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const README = join(ROOT, 'README.md');
const CLI_MD = join(ROOT, 'plugin/skills/tailor-resume/references/cli.md');
const EXAMPLES_PROFILE = join(ROOT, 'examples/profile.json');
const EXAMPLES_POSTING = join(ROOT, 'examples/posting.txt');
const EXAMPLES_PLAN = join(ROOT, 'examples/plan.json');
const RESUME_FIXTURE = join(ROOT, 'src/core/parse/__fixtures__/resume.txt');

/** The structured resume an agent would write from `ingest prompt`'s instructions — substituted here so the walkthrough needs no model. */
const STRUCTURED_RESUME = {
  basics: { name: 'Dana Reyes', label: 'Engineer', email: 'dana@example.com', phone: '', url: '', summary: '', city: '', region: '', profiles: [] },
  work: [{ name: 'Acme', position: 'Engineer', location: '', startDate: '2020', endDate: '2024', summary: '', bullets: [{ text: 'Shipped the billing service.', restates: 0 }] }],
  education: [],
  projects: [],
  skills: [{ name: 'Languages', keywords: ['Go'] }],
  certificates: [],
  awards: [],
};

function fencedBlocks(md: string): string[] {
  return [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/** Every line inside a fenced block that is itself a `sartor …` invocation (not a comment that merely mentions it), with its leading words (for its command) and the line (for its flags). */
function sartorInvocations(block: string): Array<{ line: string; words: string[] }> {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('sartor'))
    .flatMap((line) => {
      const m = /^sartor((?: [a-z]+){1,2})/.exec(line);
      return m ? [{ line, words: m[1]!.trim().split(' ') }] : [];
    });
}

/** Every `--flag` on a `sartor` line, inside a fenced block, that is not one the command it names (or any command, via `GLOBAL`) actually has. */
function flagProblems(md: string): string[] {
  const problems: string[] = [];
  for (const block of fencedBlocks(md)) {
    for (const { line, words } of sartorInvocations(block)) {
      const name = commandFor(words);
      const options = COMMANDS.find((c) => c.name === name)?.options ?? {};
      const allowed = new Set([...Object.keys(GLOBAL), ...Object.keys(options)]);
      for (const flag of line.matchAll(/--([a-z][a-z-]*)/g)) {
        if (!allowed.has(flag[1]!)) problems.push(`${name ?? words.join(' ')}: --${flag[1]} (${line.trim()})`);
      }
    }
  }
  return problems;
}

describe.each([
  ['README.md', README],
  ['the CLI reference', CLI_MD],
])('%s', (_label, path) => {
  const md = readFileSync(path, 'utf8');

  it('only tells the agent to run commands the CLI has', () => {
    const found = commandsIn(md);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((c) => !c.known).map((c) => `${path}:${c.line}: sartor ${c.said}`)).toEqual([]);
  });

  it('only uses flags the command it names has, inside a fenced code block', () => {
    expect(flagProblems(md)).toEqual([]);
  });
});

it('documents every command in the CLI reference', () => {
  const md = readFileSync(CLI_MD, 'utf8');
  for (const c of COMMANDS) expect(md, c.name).toContain(`sartor ${c.name}`);
});

/** The leading 1 or 2 lowercase words after `sartor` on a line — its command, before any flag or file name. */
function leadingWords(tokens: string[]): string[] {
  const words: string[] = [];
  for (const t of tokens) {
    if (words.length >= 2 || !/^[a-z]+$/.test(t)) break;
    words.push(t);
  }
  return words;
}

/**
 * Replaces the walkthrough's placeholder file names with real ones: the
 * profile, posting and plan an agent would be pointed at (`--profile`,
 * `--posting`, `--plan`), and the files `ingest prompt` and `ingest apply`
 * read, which the sample in `examples/` has no equivalent of.
 */
function substitute(command: string | undefined, tokens: string[], cwd: string): string[] {
  const options: Record<string, { type?: string }> = { ...GLOBAL, ...(COMMANDS.find((c) => c.name === command)?.options ?? {}) };
  const out = [...tokens];
  let positional = 0;
  for (let i = 0; i < out.length; i++) {
    const t = out[i]!;
    if (t.startsWith('--')) {
      const name = t.slice(2);
      if (options[name]?.type === 'boolean') continue;
      const valueIndex = i + 1;
      if (name === 'profile') out[valueIndex] = EXAMPLES_PROFILE;
      else if (name === 'posting') out[valueIndex] = EXAMPLES_POSTING;
      else if (name === 'plan') out[valueIndex] = EXAMPLES_PLAN;
      i = valueIndex;
      continue;
    }
    if (command === 'ingest prompt' && positional === 0) out[i] = RESUME_FIXTURE;
    if (command === 'ingest apply' && positional === 0) out[i] = join(cwd, 'structured.json');
    positional++;
  }
  return out;
}

/**
 * A change number safe to reject without growing the page past its target:
 * the first change that is not a dropped bullet or role, since restoring one
 * of those is exactly what would push a tightly-fitted one-page resume to
 * two. `--reject 4` in the doc is illustrative, not tied to this fixture.
 */
function safeRejectTarget(cwd: string): string {
  const file = JSON.parse(readFileSync(join(cwd, 'run.json'), 'utf8'));
  const changes: Array<{ kind: string }> = file.run.changes;
  const index = changes.findIndex((c) => c.kind !== 'bullet-drop' && c.kind !== 'entry-drop');
  return String((index === -1 ? 0 : index) + 1);
}

describe("the README's agent walkthrough", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'sartor-docs-'));
  });

  async function sartor(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const io: Io = {
      stdout: { write: (s: string) => (stdout += s), isTTY: false },
      stderr: { write: (s: string) => (stderr += s) },
      stdin: Object.assign((async function* () {})(), { isTTY: true }),
      cwd,
      env: {},
    };
    const code = await main([...args, '--json'], io, '0.0.0-test');
    return { code, stdout, stderr };
  }

  it('runs every command in it, each exiting 0', async () => {
    const md = readFileSync(README, 'utf8');
    const heading = '## Using it from an agent';
    const idx = md.indexOf(heading);
    expect(idx, heading).toBeGreaterThan(-1);
    const block = /```[^\n]*\n([\s\S]*?)```/.exec(md.slice(idx))?.[1];
    expect(block, 'a fenced block after the heading').toBeTruthy();

    writeFileSync(join(cwd, 'structured.json'), JSON.stringify(STRUCTURED_RESUME));

    const lines = block!
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('sartor '))
      .map((l) => l.replace(/\s+#.*$/, ''));
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const tokens = line.split(/\s+/).slice(1);
      const words = leadingWords(tokens);
      const command = commandFor(words);
      // These need a model, and the agent's own writing of structured.json or
      // plan.json between commands is not a `sartor` line to run at all.
      if (command === 'ingest run' || command === 'tailor run') continue;
      const rest = substitute(command, tokens.slice(words.length), cwd);
      if (command === 'review') {
        // Not a file-name substitution: the doc's own `--reject 4` is replaced
        // too, since that change number is illustrative and specific to this
        // fixture it would likely grow the page past its target — see
        // `safeRejectTarget`.
        const ri = rest.indexOf('--reject');
        if (ri !== -1) rest[ri + 1] = safeRejectTarget(cwd);
      }
      const r = await sartor([...words, ...rest]);
      expect(r.code, `${line}\n${r.stderr}`).toBe(0);
    }
  });
});
