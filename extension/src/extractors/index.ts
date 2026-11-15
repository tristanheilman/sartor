/**
 * Picks the extractor for the open page: the first matching site extractor
 * runs, and if it returns null or throws, the generic heuristic takes over.
 */
import { extractGeneric, type ExtractedPosting } from './generic';
import * as indeed from './indeed';
import * as linkedin from './linkedin';
import * as workday from './workday';

interface SiteExtractor {
  matches(url: string): boolean;
  extract(doc: Document, url: string): ExtractedPosting | null;
}

const SITE_EXTRACTORS: SiteExtractor[] = [linkedin, indeed, workday];

export function extractPosting(doc: Document, url: string): ExtractedPosting | null {
  const site = SITE_EXTRACTORS.find((s) => s.matches(url));
  if (site) {
    try {
      const result = site.extract(doc, url);
      if (result) return result;
    } catch {
      // fall through to the generic extractor
    }
  }
  return extractGeneric(doc, url);
}
