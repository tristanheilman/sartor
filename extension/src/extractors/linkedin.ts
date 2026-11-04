/**
 * LinkedIn job posting extractor.
 *
 * LinkedIn publishes no JSON for its postings, so this reads the description
 * container directly off the rendered page. Selectors live in one object so a
 * layout change is a one-line fix.
 */
import { htmlToText, normalizeText } from '../../../src/core/jd/normalize';
import type { ExtractedPosting } from './generic';

const SELECTORS = {
  title: 'h1.top-card-layout__title, h1.topcard__title',
  company: '.topcard__org-name-link, .top-card-layout__second-subline a',
  location: '.topcard__flavor--bullet, .top-card-layout__second-subline .topcard__flavor--bullet',
  // Ordered most-specific first: `.show-more-less-html__markup` is the inner
  // markup container without the "Show more"/"Show less" toggle that its
  // `.description__text` wrapper also carries.
  description: ['.show-more-less-html__markup', '.description__text'],
};

export function matches(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'linkedin.com' || host.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

export function extract(doc: Document, url: string): ExtractedPosting | null {
  const description = SELECTORS.description.map((selector) => doc.querySelector(selector)).find(Boolean) ?? null;
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
