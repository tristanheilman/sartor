/** Shared plumbing for the per-site extractors. */
import { htmlToText, normalizeText } from '../../../src/core/jd/normalize';
import type { ExtractedPosting } from './generic';

export interface SiteSelectors {
  title: string;
  company: string;
  location: string;
  description: string;
}

export function textOf(doc: Document, selector: string): string {
  return (doc.querySelector(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Reads the posting from the named description container. Returns null when
 * the container is missing or empty, so the dispatcher falls back to the
 * generic extractor instead of capturing the wrong text.
 */
export function extractWithSelectors(
  doc: Document,
  url: string,
  selectors: SiteSelectors,
  overrides: Partial<Pick<ExtractedPosting, 'company' | 'title'>> = {},
): ExtractedPosting | null {
  const container = doc.querySelector(selectors.description);
  if (!container) return null;
  const text = normalizeText(htmlToText(container.innerHTML));
  if (text.length === 0) return null;
  return {
    title: overrides.title || textOf(doc, selectors.title),
    company: overrides.company || textOf(doc, selectors.company),
    location: textOf(doc, selectors.location),
    url,
    text,
  };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}
