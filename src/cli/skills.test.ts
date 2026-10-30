import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from './main';

/**
 * The skills shipped in `plugin/`, held to the Agent Skills specification
 * (agentskills.io/specification) and to the CLI they drive — and the two
 * manifests that get them installed, held to each other and to `package.json`.
 *
 * The spec is what lets them load in Claude Code and in any other agent that
 * implements it. The second half is what keeps them honest: a skill that tells
 * an agent to run a command the CLI no longer has fails in someone else's
 * session, long after the rename that broke it. The manifests fail the same
 * way: `claude plugin install` reads them on another machine, where a moved
 * directory or a stale version is found only by the person it stops.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN = join(ROOT, 'plugin');
const SKILLS = join(PLUGIN, 'skills');
/** The one install text; every skill points the agent here when `sartor` is missing. */
const INSTALLING = { file: join(SKILLS, 'tailor-resume/references/cli.md'), heading: 'installing' };
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

/** Every `[text](target#fragment)` link in a markdown file. */
function linksIn(md: string): Array<{ target: string; fragment?: string }> {
  return [...md.matchAll(/\]\(([^)#\s]+)(?:#([^)\s]*))?\)/g)].map(([, target, fragment]) => (fragment === undefined ? { target: target! } : { target: target!, fragment }));
}

/** The anchors a markdown file's headings get, the way GitHub slugs them: lowercased, punctuation dropped, spaces to hyphens. */
function headingAnchors(md: string): Set<string> {
  return new Set(
    [...md.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map(([, heading]) =>
      heading!.toLowerCase().replace(/[`*_]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-'),
    ),
  );
}

function json<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
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

  // A link may reach a sibling skill in the same plugin — the two are
  // installed together, and it is how they share one CLI reference — but
  // never outside `plugin/skills`, which is all an installed plugin has.
  it('links only to files in the plugin that exist, at headings they have', () => {
    for (const { target, fragment } of linksIn(md)) {
      if (/^https?:/.test(target)) continue;
      const file = resolve(SKILLS, dir, target);
      const inside = relative(SKILLS, file);
      expect(inside.startsWith('..') || isAbsolute(inside), `${target} stays inside the plugin's skills`).toBe(false);
      expect(existsSync(file), target).toBe(true);
      if (fragment !== undefined) expect(headingAnchors(readFileSync(file, 'utf8')), `${target}#${fragment}`).toContain(fragment);
    }
  });

  it('sends the agent to the one install text when sartor is missing', () => {
    const pointers = linksIn(md).filter((l) => l.fragment === INSTALLING.heading);
    expect(pointers.length, 'links to #installing').toBeGreaterThan(0);
    for (const { target } of pointers) expect(resolve(SKILLS, dir, target)).toBe(INSTALLING.file);
    expect(headingAnchors(readFileSync(INSTALLING.file, 'utf8'))).toContain(INSTALLING.heading);
    // And does not carry a copy of the steps that could drift from it.
    expect(md).not.toMatch(/git clone|npm link/);
  });

  it('only tells the agent to run commands the CLI has', () => {
    const found = commandsIn(md);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((c) => !c.known).map((c) => c.said)).toEqual([]);
  });
});

it('references only commands the CLI has', () => {
  const md = readFileSync(INSTALLING.file, 'utf8');
  expect(commandsIn(md).filter((c) => !c.known).map((c) => c.said)).toEqual([]);
  // And documents every one of them.
  for (const c of COMMANDS) expect(md, c.name).toContain(`sartor ${c.name}`);
});

describe('the plugin manifests', () => {
  type Marketplace = { name: string; plugins: Array<{ name: string; source: string }> };
  type Plugin = { name: string; version: string };

  const marketplace = json<Marketplace>(join(ROOT, '.claude-plugin/marketplace.json'));
  const plugin = json<Plugin>(join(PLUGIN, '.claude-plugin/plugin.json'));
  const pkg = json<{ version: string }>(join(ROOT, 'package.json'));

  it('list the plugin at a source that holds a plugin manifest and the skills', () => {
    const entry = marketplace.plugins.find((p) => p.name === plugin.name);
    expect(entry, `a plugin named ${plugin.name}`).toBeDefined();
    // Sources are relative to the repository the marketplace file sits in.
    const source = resolve(ROOT, entry!.source);
    expect(existsSync(join(source, '.claude-plugin/plugin.json')), `${entry!.source}/.claude-plugin/plugin.json`).toBe(true);
    expect(relative(source, SKILLS)).toBe('skills');
  });

  it('carry the package version', () => {
    expect(plugin.version).toBe(pkg.version);
  });
});
