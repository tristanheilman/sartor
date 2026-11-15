import type { ExtractedPosting } from './generic';
import { extractWithSelectors, hostOf, type SiteSelectors } from './site';

/** One-line fixes when Indeed changes its layout. */
export const INDEED_SELECTORS: SiteSelectors = {
  title: '.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"], h1',
  company: '[data-testid="inlineHeader-companyName"], [data-company-name="true"]',
  location: '[data-testid="inlineHeader-companyLocation"], [data-testid="job-location"]',
  description: '#jobDescriptionText',
};

export function matches(url: string): boolean {
  const host = hostOf(url);
  return host === 'indeed.com' || host.endsWith('.indeed.com');
}

export function extract(doc: Document, url: string): ExtractedPosting | null {
  return extractWithSelectors(doc, url, INDEED_SELECTORS);
}
