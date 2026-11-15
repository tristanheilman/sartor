// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractPosting } from './index';
import { extract, matches } from './linkedin';

const URL_OK = 'https://www.linkedin.com/jobs/view/1';
const BODY = 'Filler sentence about the work, the team, and the tools, written for this test only. '.repeat(5);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const FULL = parse(`<body><nav>Chrome navigation</nav>
<div class="top-card-layout__card">
  <h1 class="top-card-layout__title">Test Engineer</h1>
  <a class="topcard__org-name-link">Example Co</a>
  <span class="topcard__flavor topcard__flavor--bullet">Testville, TS</span>
</div>
<div class="show-more-less-html__markup"><p>${BODY}</p><p>Requirements: five years of testing.</p></div></body>`);

const BROKEN = parse(`<body><nav>Chrome navigation</nav>
<h1 class="top-card-layout__title">Test Engineer</h1>
<main><div class="job-description"><p>${BODY} generic fallback body, with commas, and more.</p><p>${BODY}</p></div></main></body>`);

describe('linkedin extractor', () => {
  it('matches its hosts only', () => {
    expect(matches(URL_OK)).toBe(true);
    expect(matches('https://example.com/jobs/1')).toBe(false);
  });

  it('extracts title, company, location and requirements', () => {
    const result = extract(FULL, URL_OK);
    expect(result).toMatchObject({
      title: 'Test Engineer',
      company: 'Example Co',
      location: 'Testville, TS',
      url: URL_OK,
    });
    expect(result?.text).toContain('Requirements: five years of testing.');
    expect(result?.text).not.toContain('Chrome navigation');
  });

  it('falls back to the generic extractor when the container is gone', () => {
    expect(extract(BROKEN, URL_OK)).toBeNull();
    const result = extractPosting(BROKEN, URL_OK);
    expect(result?.company).toBe('');
    expect(result?.text).toContain('generic fallback body');
    expect(result?.text).not.toContain('Chrome navigation');
  });
});
