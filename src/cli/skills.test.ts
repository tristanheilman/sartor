import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from './main';

/**
 * The skills shipped in `plugin/`, held to the Agent Skills specification
 * (agentskills.io/specification) and to the CLI they drive.
 *
 * The spec is what lets them load in Claude Code and in any other agent that
 * implements it. The second half is what keeps them honest: a skill that tells
 * an agent to run a command the CLI no longer has fails in someone else's
 * session, long after the rename that broke it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILLS = join(ROOT, 'plugin/skills');
const skills = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^"|"$/g, '');
  }
  return out;
}

const known = new Set(COMMANDS.map((c) => c.name));

/**
 * Every `sartor …` invocation in a markdown file — inline or in a code block —
 * as the command it names: the longest run of its leading words that is a
 * real command, or those words as written when none is.
 */
function commandsIn(md: string): Array<{ said: string; known: boolean }> {
  return [...md.matchAll(/(?:^|[`\s(])sartor((?: [a-z]+){1,2})/gm)].flatMap((m): Array<{ said: string; known: boolean }> => {
    const words = m[1]!.trim().split(' ');
    if (words[0] === 'version' || words[0] === 'help') return [];
    for (const n of [2, 1]) {
      const name = words.slice(0, n).join(' ');
      if (known.has(name)) return [{ said: name, known: true }];
    }
    return [{ said: words.join(' '), known: false }];
  });
}

it('ships skills', () => {
  expect(skills.length).toBeGreaterThan(0);
});

describe.each(skills)('the %s skill', (dir) => {
  const path = join(SKILLS, dir, 'SKILL.md');
  const md = readFileSync(path, 'utf8');
  const fm = frontmatter(md);

  it('has a name matching its directory, in the allowed characters', () => {
    expect(fm.name).toBe(dir);
    expect(fm.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fm.name!.length).toBeLessThanOrEqual(64);
  });

  it('says what it does and when to use it, within the limit', () => {
    expect(fm.description!.length).toBeGreaterThan(0);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
    expect(fm.description).toMatch(/Use when/);
  });

  it('keeps optional fields within their limits', () => {
    if (fm.compatibility) expect(fm.compatibility.length).toBeLessThanOrEqual(500);
  });

  it('stays under 500 lines', () => {
    expect(md.split('\n').length).toBeLessThan(500);
  });

  it('links only to files inside the skill that exist', () => {
    for (const [, target] of md.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(target!)) continue;
      expect(target, 'stays inside the skill').not.toMatch(/^\.\.|^\//);
      expect(existsSync(join(SKILLS, dir, target!)), target).toBe(true);
    }
  });

  it('only tells the agent to run commands the CLI has', () => {
    const found = commandsIn(md);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((c) => !c.known).map((c) => c.said)).toEqual([]);
  });
});

it('references only commands the CLI has', () => {
  const md = readFileSync(join(SKILLS, 'tailor-resume/references/cli.md'), 'utf8');
  expect(commandsIn(md).filter((c) => !c.known).map((c) => c.said)).toEqual([]);
  // And documents every one of them.
  for (const c of COMMANDS) expect(md, c.name).toContain(`sartor ${c.name}`);
});
