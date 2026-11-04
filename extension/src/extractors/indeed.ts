/**
 * Indeed job posting extractor.
 *
 * Indeed publishes no JSON for its postings, so this reads the description
 * container directly off the rendered page. Selectors live in one object so a
 * layout change is a one-line fix.
 */
import { htmlToText, normalizeText } from '../../../src/core/jd/normalize';
import type { ExtractedPosting } from './generic';

const SELECTORS = {
  title: 'h1.jobsearch-JobInfoHeader-title',
  company: '[data-testid="inlineHeader-companyName"]',
  location: '[data-testid="inlineHeader-companyLocation"]',
  description: '#jobDescriptionText',
};

export function matches(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'indeed.com' || host.endsWith('.indeed.com');
  } catch {
    return false;
  }
}

export function extract(doc: Document, url: string): ExtractedPosting | null {
  const description = doc.querySelector(SELECTORS.description);
  if (!description) return null;

  const text = normalizeText(htmlToText(description.innerHTML));
  if (!text) return null;

  return {
    title: doc.querySelector(SELECTORS.title)?.textContent?.trim() ?? '',
    company: doc.querySelector(SELECTORS.company)?.textContent?.trim() ?? '',
    location: doc.querySelector(SELECTORS.location)?.textContent?.trim() ?? '',
    url,
    text,
  };
}
