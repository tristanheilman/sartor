// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractGeneric } from './generic';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function parse(fixture: string): Document {
  const html = readFileSync(join(fixturesDir, fixture), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('extractGeneric', () => {
  it('extracts the posting out of a page with nav, sidebar and related jobs', () => {
    const doc = parse('posting-with-nav.html');
    const result = extractGeneric(doc, 'https://example.com/jobs/software-engineer');

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Software Engineer');
    expect(result?.text).toContain('professional experience with TypeScript');
    expect(result?.text).toContain('operating distributed systems');

    expect(result?.text).not.toContain('Backend Engineer');
    expect(result?.text).not.toContain('Frontend Engineer');
    expect(result?.text).not.toContain('Platform Engineer');
    expect(result?.text).not.toContain('Home');
    expect(result?.text).not.toContain('Acme Corp');
  });

  it('extracts the posting out of a deeply nested layout', () => {
    const doc = parse('nested-layout.html');
    const result = extractGeneric(doc, 'https://example.com/careers/staff-platform-engineer');

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Staff Platform Engineer');
    expect(result?.text).toContain('Own the architecture of the internal deployment');
    expect(result?.text).toContain('technical leadership without direct reports');

    expect(result?.text).not.toContain('Filter by team');
    expect(result?.text).not.toContain('Mobile');
    expect(result?.text).not.toContain('Privacy');
  });

  it('returns null for a search-results page', () => {
    const doc = parse('search-results.html');
    const result = extractGeneric(doc, 'https://example.com/jobs?q=engineer');

    expect(result).toBeNull();
  });
});
