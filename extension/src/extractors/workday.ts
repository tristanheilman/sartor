/**
 * Workday job posting extractor.
 *
 * Workday-hosted job boards live on many `*.myworkdayjobs.com` subdomains, one
 * per employer, and some employers front them with a custom domain instead. A
 * fixed host match would miss those, so this also recognises Workday's
 * `data-automation-id` markup, which stays stable across both. Selectors live
 * in one object so a layout change is a one-line fix.
 */
import { htmlToText, normalizeText } from '../../../src/core/jd/normalize';
import type { ExtractedPosting } from './generic';

const SELECTORS = {
  title: '[data-automation-id="jobPostingHeader"]',
  location: '[data-automation-id="locations"]',
  description: '[data-automation-id="jobPostingDescription"]',
};

export function matches(url: string, doc?: Document): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host === 'myworkdayjobs.com' || host.endsWith('.myworkdayjobs.com')) return true;
  } catch {
    // Not a parseable URL; fall through to the doc-based check below.
  }
  return doc?.querySelector(SELECTORS.description) != null;
}

export function extract(doc: Document, url: string): ExtractedPosting | null {
  const description = doc.querySelector(SELECTORS.description);
  if (!description) return null;

  const text = normalizeText(htmlToText(description.innerHTML));
  if (!text) return null;

  return {
    title: doc.querySelector(SELECTORS.title)?.textContent?.trim() ?? '',
    company: companyFromHost(url),
    location: doc.querySelector(SELECTORS.location)?.textContent?.trim() ?? '',
    url,
    text,
  };
}

/** Workday carries no company name in the markup itself; on a
 * `*.myworkdayjobs.com` host the employer is the first label of the
 * subdomain, e.g. `acme.wd5...`. Custom domains give no such signal, so this
 * guesses nothing rather than turning a domain label into the wrong name. */
function companyFromHost(url: string): string {
  try {
    const host = new URL(url).hostname;
    if (!host.endsWith('.myworkdayjobs.com')) return '';
    const subdomain = host.slice(0, -'.myworkdayjobs.com'.length).split('.')[0];
    if (!subdomain) return '';
    return subdomain
      .split(/[-_]/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  } catch {
    return '';
  }
}
