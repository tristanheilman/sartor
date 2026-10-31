import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, GLOBAL, main } from './main';
import { commandsIn } from './markdown-commands';
import type { Io } from './io';

/**
 * The README and the CLI reference, held to the CLI they document — the
 * same discipline `skills.test.ts` applies to the plugin skills, extended to
 * every `--flag` on a fenced-block line and to actually running the
 * README's agent walkthrough. A renamed command or flag breaks the public
 * docs silently otherwise, long after whoever renamed it has moved on.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const CASE = join(ROOT, 'evals/cases/platform-stretch');
const RESUME_FIXTURE = join(ROOT, 'src/core/parse/__fixtures__/resume.txt');

const known = new Set(COMMANDS.map((c) => c.name));
const globalFlags = new Set(Object.keys(GLOBAL));

const DOCS: Array<[string, string]> = [
  ['README.md', join(ROOT, 'README.md')],
  ['plugin/skills/tailor-resume/references/cli.md', join(ROOT, 'plugin/skills/tailor-resume/references/cli.md')],
];

describe.each(DOCS)('%s', (relPath, path) => {
  const md = readFileSync(path, 'utf8');

  it('only tells the agent to run commands the CLI has', () => {
    const unknown = commandsIn(md, known).filter((c) => !c.known);
    expect(unknown.map((c) => `${relPath}:${c.line}: sartor ${c.said}`)).toEqual([]);
  });

  it('only uses flags the named command or the CLI itself has, on a fenced-block line', () => {
    const bad: string[] = [];
    for (const { said, known: isKnown, flags, line, fenced } of commandsIn(md, known)) {
      if (!fenced || !isKnown || flags.length === 0) continue;
      const command = COMMANDS.find((c) => c.name === said)!;
      const allowed = new Set([...Object.keys(command.options), ...globalFlags]);
      for (const flag of flags) {
        if (!allowed.has(flag)) bad.push(`${relPath}:${line}: --${flag} is not an option of \`sartor ${said}\``);
      }
    }
    expect(bad).toEqual([]);
  });
});

/** The markdown between a `## heading` and the next heading at the same level. */
function section(md: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = new RegExp(`^##\\s+${escaped}\\s*$`, 'm').exec(md);
  if (!start) throw new Error(`README.md has no "## ${heading}" heading`);
  const rest = md.slice(start.index + start[0].length);
  const next = /^##\s+\S/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The lines of the first fenced code block in a markdown snippet. */
function firstFencedBlock(md: string): string[] {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(md);
  if (!m) throw new Error('no fenced code block found');
  return m[1]!.split('\n');
}

// A structured resume shaped like `ingest apply` expects — the input the
// README's walkthrough assumes the agent already wrote from `ingest prompt`,
// which this test skips since it takes a model to produce for real.
const STRUCTURED_RESUME = {
  basics: { name: 'Dana Reyes', label: 'Engineer', email: 'dana@example.com', phone: '', url: '', summary: '', city: '', region: '', profiles: [] },
  work: [{ name: 'Acme', position: 'Engineer', location: '', startDate: '2020', endDate: '2024', summary: '', bullets: [{ text: 'Shipped the billing service.', restates: 0 }] }],
  education: [],
  projects: [],
  skills: [{ name: 'Languages', keywords: ['Go'] }],
  certificates: [],
  awards: [],
};

describe('"Using it from an agent"', () => {
  it('runs every step that needs no model, against a sample profile, posting and plan', async () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const block = firstFencedBlock(section(readme, 'Using it from an agent'));

    const cwd = mkdtempSync(join(tmpdir(), 'sartor-readme-'));
    // Stands in for the agent's own writing step ahead of `ingest apply`.
    writeFileSync(join(cwd, 'structured.json'), JSON.stringify(STRUCTURED_RESUME));

    async function sartor(argv: string[]): Promise<{ code: number; stderr: string; json: any }> {
      let stdout = '';
      let stderr = '';
      const io: Io = {
        stdout: { write: (s: string) => (stdout += s), isTTY: false },
        stderr: { write: (s: string) => (stderr += s) },
        stdin: Object.assign((async function* () {})(), { isTTY: true }),
        cwd,
        env: {},
      };
      const code = await main(argv, io, '0.0.0-test');
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      return { code, stderr, json };
    }

    for (const raw of block) {
      const line = raw.split('#')[0]!.trim();
      if (!line.startsWith('sartor')) continue; // a continuation comment, e.g. "agent writes plan.json"
      const tokens = line.split(/\s+/).slice(1);

      let name: string | undefined;
      let rest = tokens;
      for (const n of [2, 1]) {
        const candidate = tokens.slice(0, n).join(' ');
        if (known.has(candidate)) {
          name = candidate;
          rest = tokens.slice(n);
          break;
        }
      }
      if (!name) throw new Error(`README.md: \`${line}\` does not name a known command`);
      if (name === 'ingest run' || name === 'tailor run') continue; // needs a model

      const args = rest.map((t, i) => {
        const prev = rest[i - 1];
        if (prev === '--profile' && t === 'profile.json') return join(CASE, 'profile.json');
        if (prev === '--posting' && t === 'posting.txt') return join(CASE, 'posting.txt');
        if (prev === '--plan' && t === 'plan.json') return join(CASE, 'plans', '01.json');
        if (name === 'ingest prompt' && t === 'resume.pdf') return RESUME_FIXTURE;
        return t;
      });

      const r = await sartor([...name.split(' '), ...args, '--json']);
      expect(r.code, `\`${line}\` exited ${r.code}: ${r.stderr}`).toBe(0);
      expect(r.json?.ok, `\`${line}\`: ${JSON.stringify(r.json)}`).toBe(true);
    }
  });
});
