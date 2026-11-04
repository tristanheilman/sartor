// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractPosting } from './index';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function parse(fixture: string): Document {
  const html = readFileSync(join(fixturesDir, fixture), 'utf-8');
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('extractPosting', () => {
  it('runs the matching site extractor over the generic fallback', () => {
    const doc = parse('linkedin-posting.html');
    const result = extractPosting(doc, 'https://www.linkedin.com/jobs/view/1234567');

    expect(result?.company).toBe('Acme Labs');
  });

  it('still uses the generic extractor on a site with no dedicated extractor', () => {
    const doc = parse('posting-with-nav.html');
    const result = extractPosting(doc, 'https://example.com/jobs/software-engineer');

    expect(result?.title).toBe('Software Engineer');
    expect(result?.company).toBe('');
  });
});
