import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandsIn, frontmatter } from './doc-commands';

/**
 * The skills shipped in `plugin/`, held to the Agent Skills specification
 * (agentskills.io/specification) and to the CLI they drive.
 *
 * The spec is what lets them load in Claude Code and in any other agent that
 * implements it. The second half is what keeps them honest: a skill that tells
 * an agent to run a command the CLI no longer has fails in someone else's
 * session, long after the rename that broke it.
 *
 * The last part holds the three files the install procedure depends on to
 * each other: the marketplace entry has to point at the plugin, the plugin has
 * to carry the package's version, and the one install text the skills send an
 * agent to has to be where they say it is.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILLS = join(ROOT, 'plugin/skills');
const skills = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

function json(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The anchors a markdown file's headings get: lower-cased, punctuation dropped, spaces to hyphens. */
function anchors(md: string): Set<string> {
  return new Set([...md.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((m) => m[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')));
}

/** Every relative markdown link in a skill file, resolved from that skill's directory. */
function links(md: string, dir: string): Array<{ said: string; file: string; anchor?: string }> {
  return [...md.matchAll(/\]\(([^)#]+)(?:#([^)]*))?\)/g)]
    .filter(([, target]) => !/^https?:/.test(target!))
    .map(([, target, anchor]) => ({ said: target!, file: resolve(SKILLS, dir, target!), anchor }));
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

  it('links only to files inside the plugin that exist', () => {
    for (const { said, file } of links(md, dir)) {
      // Its own files, or a sibling skill's: the plugin installs as one unit.
      expect(relative(SKILLS, file), `${said} stays inside the plugin`).not.toMatch(/^\.\.|^\//);
      expect(existsSync(file), said).toBe(true);
    }
  });

  it('sends the agent to an install section that exists', () => {
    const anchored = links(md, dir).filter((l) => l.anchor !== undefined);
    expect(anchored.map((l) => l.anchor), 'points at #installing').toContain('installing');
    for (const { said, file, anchor } of anchored) {
      expect(existsSync(file), said).toBe(true);
      expect(anchors(readFileSync(file, 'utf8')), `${said}#${anchor}`).toContain(anchor);
    }
  });

  it('only tells the agent to run commands the CLI has', () => {
    const found = commandsIn(md);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((c) => !c.known).map((c) => `${path}:${c.line}: sartor ${c.said}`)).toEqual([]);
  });
});

describe('the plugin manifests', () => {
  const marketplace = json(join(ROOT, '.claude-plugin/marketplace.json'));
  const pkg = json(join(ROOT, 'package.json'));
  const entries: Array<{ name: string; source: string }> = marketplace.plugins;

  it('list a plugin whose source is a directory holding a plugin manifest', () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const dir = resolve(ROOT, entry.source);
      expect(existsSync(dir) && statSync(dir).isDirectory(), `${entry.source} is a directory`).toBe(true);
      const manifest = join(dir, '.claude-plugin/plugin.json');
      expect(existsSync(manifest), relative(ROOT, manifest)).toBe(true);
      expect(json(manifest).name, 'the manifest names the plugin the marketplace lists').toBe(entry.name);
    }
  });

  it('ship the skills under the plugin the marketplace points at', () => {
    expect(entries.map((e) => resolve(ROOT, e.source, 'skills'))).toContain(SKILLS);
  });

  it('give the plugin the package version', () => {
    for (const entry of entries) {
      expect(json(resolve(ROOT, entry.source, '.claude-plugin/plugin.json')).version, entry.name).toBe(pkg.version);
    }
  });

  it('are what the README installs', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    for (const entry of entries) expect(readme).toContain(`claude plugin install ${entry.name}@${marketplace.name}`);
  });
});
