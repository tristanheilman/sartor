/**
 * Site-extractor dispatcher.
 *
 * The first matching site extractor runs. When it returns `null` or throws —
 * because the page layout has changed, say — this falls back to the generic
 * readability-style extractor rather than surfacing wrong or missing text.
 */
import { extractGeneric, type ExtractedPosting } from './generic';
import * as indeed from './indeed';
import * as linkedin from './linkedin';
import * as workday from './workday';

interface SiteExtractor {
  matches(url: string, doc?: Document): boolean;
  extract(doc: Document, url: string): ExtractedPosting | null;
}

const SITE_EXTRACTORS: SiteExtractor[] = [linkedin, indeed, workday];

export function extractPosting(doc: Document, url: string): ExtractedPosting | null {
  const siteExtractor = SITE_EXTRACTORS.find((extractor) => extractor.matches(url, doc));

  if (siteExtractor) {
    try {
      const result = siteExtractor.extract(doc, url);
      if (result) return result;
    } catch {
      // Fall through to the generic extractor below.
    }
  }

  return extractGeneric(doc, url);
}

export type { ExtractedPosting };
