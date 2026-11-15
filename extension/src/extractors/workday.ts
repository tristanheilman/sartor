import type { ExtractedPosting } from './generic';
import { extractWithSelectors, hostOf, type SiteSelectors } from './site';

/** One-line fixes when Workday changes its markup. Keyed on `data-automation-id`, which is stable across tenants. */
export const WORKDAY_SELECTORS: SiteSelectors = {
  title: '[data-automation-id="jobPostingHeader"], h1',
  // Workday has no company element; `companyFromPage` is tried first.
  company: '[data-automation-id="companyName"]',
  location: '[data-automation-id="locations"], [data-automation-id="jobPostingLocation"]',
  description: '[data-automation-id="jobPostingDescription"]',
};

/** Tenants live on many subdomains, so match the host suffix, not a fixed host. */
export function matches(url: string): boolean {
  return hostOf(url).endsWith('.myworkdayjobs.com');
}

function companyFromPage(doc: Document): string {
  const site = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
  return site?.trim() ?? '';
}

export function extract(doc: Document, url: string): ExtractedPosting | null {
  return extractWithSelectors(doc, url, WORKDAY_SELECTORS, { company: companyFromPage(doc) });
}
