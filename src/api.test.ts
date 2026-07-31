import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

/**
 * Guards on the public API surface.
 *
 * Two things here are easy to break by accident and expensive to discover late:
 * the app quietly reaching past its own public entry, and the two render
 * engines being merged back into one import.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const appFiles = [...walk('src/ui'), ...walk('src/storage')];
const importRe = /from\s+'([^']+)'/g;

describe('the app consumes its own public API', () => {
  it('has app files to check', () => {
    expect(appFiles.length).toBeGreaterThan(10);
  });

  it('never reaches past the public entry into core/', () => {
    const offenders: string[] = [];
    for (const file of appFiles) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(importRe)) {
        if (m[1]!.includes('core/')) offenders.push(`${file} -> ${m[1]}`);
      }
    }
    // If this fails, something in src/ui or src/storage is importing an
    // internal directly. Either export it from src/index.ts, or it does not
    // belong in the published surface and the app should not need it.
    expect(offenders).toEqual([]);
  });

  it('reaches outside its own directory only through a published entry point', () => {
    const published = new Set(['src/index', 'src/parse', 'src/render/pdf', 'src/render/docx']);
    const bad: string[] = [];

    for (const file of appFiles) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(importRe)) {
        const spec = m[1]!;
        if (!spec.startsWith('.')) continue; // bare specifier: a real dependency

        // Resolve against the importing file so `../store` from components/
        // is recognised as the app-internal sibling it is.
        const resolved = join(dirname(file), spec).split(sep).join('/');
        const insideApp = resolved.startsWith('src/ui/') || resolved.startsWith('src/storage/');
        if (insideApp || published.has(resolved)) continue;
        bad.push(`${file} -> ${spec} (resolves to ${resolved})`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('every imported package is declared', () => {
  /**
   * A dependency that is used but undeclared works fine locally — `node_modules`
   * still has it from an earlier install — and fails only on a clean `npm ci`.
   * That is exactly how `file-saver` reached CI: it was dropped from the
   * manifest while splitting deps for the library, and nothing local noticed.
   */
  it('declares every bare specifier imported anywhere in src/', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);

    const undeclared = new Set<string>();
    for (const file of [...appFiles, ...walk('src/core'), 'src/index.ts', 'src/parse.ts']) {
      // Strip comments first: the entry points document their own usage with
      // `import('sartor/render/pdf')` in prose, which is not a real import.
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)'([^'.][^']*)'/g)) {
        const spec = m[1]!;
        if (spec.startsWith('node:')) continue;
        const parts = spec.split('/');
        const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
        // `react/jsx-runtime` resolves through `react`.
        if (!declared.has(name)) undeclared.add(`${name} (in ${file})`);
      }
    }
    expect([...undeclared]).toEqual([]);
  });
});

describe('render engines stay separately loadable', () => {
  it('exposes PDF and DOCX as distinct entry points', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports)).toContain('./render/pdf');
    expect(Object.keys(pkg.exports)).toContain('./render/docx');
    // A combined barrel would mean anyone exporting a DOCX also ships the PDF
    // engine — several hundred kilobytes they never execute.
    expect(Object.keys(pkg.exports)).not.toContain('./render');
  });

  it('keeps each render entry importing only its own engine', () => {
    const pdf = readFileSync('src/render/pdf.ts', 'utf8');
    const docx = readFileSync('src/render/docx.ts', 'utf8');
    expect(pdf).toContain('core/render/pdf');
    expect(pdf).not.toContain('core/render/docx');
    expect(docx).toContain('core/render/docx');
    expect(docx).not.toContain('core/render/pdf');
  });

  it('loads the two renderers through separate dynamic imports in the app', () => {
    const src = readFileSync('src/ui/components/ExportPanel.tsx', 'utf8');
    expect(src).toMatch(/import\('\.\.\/\.\.\/render\/pdf'\)/);
    expect(src).toMatch(/import\('\.\.\/\.\.\/render\/docx'\)/);
  });
});
