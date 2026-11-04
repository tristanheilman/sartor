// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPosting } from './index';
import { extract, matches } from './workday';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function parse(fixture: string): Document {
  const html = readFileSync(join(fixturesDir, fixture), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

const URL = 'https://acme.wd5.myworkdayjobs.com/External/job/Denver-CO/Staff-SRE_R1234';
const CUSTOM_DOMAIN_URL = 'https://careers.acme.com/job/Denver-CO/Staff-SRE_R1234';

describe('workday matches', () => {
  it('matches myworkdayjobs.com hosts', () => {
    expect(matches(URL)).toBe(true);
  });

  it('matches a custom domain via data-automation-id attributes', () => {
    const doc = parse('workday-posting.html');
    expect(matches(CUSTOM_DOMAIN_URL, doc)).toBe(true);
  });

  it('does not match an unrelated custom domain without the markup', () => {
    const doc = parse('workday-posting-broken.html');
    expect(matches(CUSTOM_DOMAIN_URL, doc)).toBe(false);
  });
});

describe('workday extract', () => {
  it('extracts title, company, location and requirements', () => {
    const doc = parse('workday-posting.html');
    const result = extract(doc, URL);

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Staff Site Reliability Engineer');
    expect(result?.company).toBe('Acme');
    expect(result?.location).toBe('Denver, Colorado');
    expect(result?.text).toContain('operating production services at scale');
    expect(result?.text).not.toContain('Senior SRE');
  });

  it('returns null when the description container is missing', () => {
    const doc = parse('workday-posting-broken.html');
    expect(extract(doc, URL)).toBeNull();
  });

  it('guesses no company name on a custom domain', () => {
    const doc = parse('workday-posting.html');
    const result = extract(doc, CUSTOM_DOMAIN_URL);

    expect(result?.company).toBe('');
  });
});

describe('dispatcher fallback', () => {
  it('falls back to the generic extractor when the layout changes', () => {
    const doc = parse('workday-posting-broken.html');
    const result = extractPosting(doc, URL);

    expect(result).not.toBeNull();
    expect(result?.company).toBe('');
    expect(result?.text).toContain('its own readability heuristic');
  });
});
