// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extract, matches } from './indeed';
import { extractPosting } from './index';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function parse(fixture: string): Document {
  const html = readFileSync(join(fixturesDir, fixture), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

const URL = 'https://www.indeed.com/viewjob?jk=abc123';

describe('indeed matches', () => {
  it('matches indeed.com job urls', () => {
    expect(matches(URL)).toBe(true);
  });

  it('does not match other hosts', () => {
    expect(matches('https://example.com/jobs/1')).toBe(false);
  });

  it('does not match a host that merely ends with indeed.com', () => {
    expect(matches('https://notindeed.com/viewjob?jk=abc123')).toBe(false);
  });
});

describe('indeed extract', () => {
  it('extracts title, company, location and requirements', () => {
    const doc = parse('indeed-posting.html');
    const result = extract(doc, URL);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Product Designer');
    expect(result?.company).toBe('Brightwell Co');
    expect(result?.location).toBe('Austin, TX');
    expect(result?.text).toContain('designing complex web products');
    expect(result?.text).not.toContain('Product Manager');
  });

  it('returns null when the description container is missing', () => {
    const doc = parse('indeed-posting-broken.html');
    expect(extract(doc, URL)).toBeNull();
  });
});

describe('dispatcher fallback', () => {
  it('falls back to the generic extractor when the layout changes', () => {
    const doc = parse('indeed-posting-broken.html');
    const result = extractPosting(doc, URL);

    expect(result).not.toBeNull();
    expect(result?.company).toBe('');
    expect(result?.text).toContain('generic readability heuristic');
  });
});
