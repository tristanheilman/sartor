// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPosting } from './index';
import { extract, matches } from './linkedin';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function parse(fixture: string): Document {
  const html = readFileSync(join(fixturesDir, fixture), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

const URL = 'https://www.linkedin.com/jobs/view/1234567';

describe('linkedin matches', () => {
  it('matches linkedin.com job urls', () => {
    expect(matches(URL)).toBe(true);
  });

  it('does not match other hosts', () => {
    expect(matches('https://example.com/jobs/1')).toBe(false);
  });

  it('does not match a host that merely ends with linkedin.com', () => {
    expect(matches('https://notlinkedin.com/jobs/view/1234567')).toBe(false);
  });
});

describe('linkedin extract', () => {
  it('extracts title, company, location and requirements', () => {
    const doc = parse('linkedin-posting.html');
    const result = extract(doc, URL);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Senior Backend Engineer');
    expect(result?.company).toBe('Acme Labs');
    expect(result?.location).toBe('Remote');
    expect(result?.text).toContain('building backend services in a typed language');
    expect(result?.text).not.toContain('Staff Backend Engineer');
    expect(result?.text).not.toContain('Show more');
  });

  it('returns null when the description container is missing', () => {
    const doc = parse('linkedin-posting-broken.html');
    expect(extract(doc, URL)).toBeNull();
  });
});

describe('dispatcher fallback', () => {
  it('falls back to the generic extractor when the layout changes', () => {
    const doc = parse('linkedin-posting-broken.html');
    const result = extractPosting(doc, URL);

    expect(result).not.toBeNull();
    expect(result?.company).toBe('');
    expect(result?.text).toContain('generic fallback has to pick this block up');
  });
});
