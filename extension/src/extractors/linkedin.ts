import type { ExtractedPosting } from './generic';
import { extractWithSelectors, hostOf, type SiteSelectors } from './site';

/** One-line fixes when LinkedIn changes its layout. Public and signed-in views are both listed. */
export const LINKEDIN_SELECTORS: SiteSelectors = {
  title: '.top-card-layout__title, .job-details-jobs-unified-top-card__job-title, h1',
  company:
    '.topcard__org-name-link, .job-details-jobs-unified-top-card__company-name',
  location:
    '.topcard__flavor--bullet, .job-details-jobs-unified-top-card__bullet',
  description: '.show-more-less-html__markup, .jobs-description__content, .description__text',
};

export function matches(url: string): boolean {
  const host = hostOf(url);
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

export function extract(doc: Document, url: string): ExtractedPosting | null {
  return extractWithSelectors(doc, url, LINKEDIN_SELECTORS);
}
