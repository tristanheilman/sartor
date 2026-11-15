// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { extractPosting } from './index';
import { extract, matches } from './workday';

const URL_OK = 'https://example.wd5.myworkdayjobs.com/en-US/Careers/job/Testville/Test-Engineer_R1';
const BODY = 'Filler sentence about the work, the team, and the tools, written for this test only. '.repeat(5);

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

const FULL = parse(`<head><meta property="og:site_name" content="Example Co"></head>
<body><nav>Chrome navigation</nav>
<h2 data-automation-id="jobPostingHeader">Test Engineer</h2>
<div data-automation-id="locations">Testville, TS</div>
<div data-automation-id="jobPostingDescription"><p>${BODY}</p><p>Requirements: five years of testing.</p></div></body>`);

const BROKEN = parse(`<head><meta property="og:site_name" content="Example Co"></head>
<body><nav>Chrome navigation</nav>
<h2 data-automation-id="jobPostingHeader">Test Engineer</h2>
<main><div class="job-description"><p>${BODY} generic fallback body, with commas, and more.</p><p>${BODY}</p></div></main></body>`);

describe('workday extractor', () => {
  it('matches any tenant subdomain, and nothing else', () => {
    expect(matches(URL_OK)).toBe(true);
    expect(matches('https://other.wd1.myworkdayjobs.com/x')).toBe(true);
    expect(matches('https://example.com/jobs/1')).toBe(false);
    expect(matches('https://myworkdayjobs.com.evil.example/x')).toBe(false);
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
