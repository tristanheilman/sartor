import { describe, it, expect } from 'vitest';
import { detectAts } from './ats';
import { htmlToText, normalizeText, fromPaste } from './normalize';

describe('detectAts', () => {
  it('recognises Greenhouse board URLs', () => {
    const t = detectAts('https://boards.greenhouse.io/acme/jobs/4012345');
    expect(t).toMatchObject({
      vendor: 'greenhouse',
      board: 'acme',
      jobId: '4012345',
      apiUrl: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345',
    });
  });

  it('recognises the newer job-boards Greenhouse host', () => {
    expect(detectAts('https://job-boards.greenhouse.io/acme/jobs/9')?.vendor).toBe('greenhouse');
  });

  it('recognises Lever URLs', () => {
    const t = detectAts('https://jobs.lever.co/acme/2b1f-uuid?lever-source=x');
    expect(t).toMatchObject({
      vendor: 'lever',
      apiUrl: 'https://api.lever.co/v0/postings/acme/2b1f-uuid',
    });
  });

  it('recognises Ashby URLs', () => {
    expect(detectAts('https://jobs.ashbyhq.com/acme/abc-123')?.vendor).toBe('ashby');
  });

  it('returns null for unrelated or malformed URLs', () => {
    expect(detectAts('https://www.linkedin.com/jobs/view/123')).toBeNull();
    expect(detectAts('not a url')).toBeNull();
    expect(detectAts('https://boards.greenhouse.io/acme')).toBeNull();
  });
});

describe('htmlToText', () => {
  it('preserves list and paragraph structure', () => {
    const text = htmlToText('<p>We want:</p><ul><li>Go</li><li>PostgreSQL</li></ul>');
    // The paragraph break survives as a blank line; each list item gets its own
    // line and marker. Both matter — requirement lists are where the signal is.
    expect(normalizeText(text)).toBe('We want:\n\n• Go\n• PostgreSQL');
  });

  it('decodes entities', () => {
    expect(htmlToText('R&amp;D &mdash; 5&nbsp;years').trim()).toBe('R&D — 5 years');
  });

  it('drops scripts and styles', () => {
    expect(htmlToText('<script>evil()</script><p>Real</p>').trim()).toBe('Real');
  });
});

describe('fromPaste', () => {
  it('accepts plain text unchanged', () => {
    const jd = fromPaste('Senior Engineer\n\nWe need Go.');
    expect(jd.source).toBe('paste');
    expect(jd.title).toBe('Senior Engineer');
    expect(jd.text).toContain('We need Go.');
  });

  it('strips markup when HTML is pasted', () => {
    const jd = fromPaste('<div><h1>Staff Engineer</h1><p>Rust required.</p></div>');
    expect(jd.text).not.toContain('<');
    expect(jd.text).toContain('Rust required.');
  });
});
