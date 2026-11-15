/**
 * Runs on the clicked tab, on a user gesture (`activeTab`), and nothing else.
 * It reads the job description from the page with the site extractor for that
 * page (or the generic fallback) and leaves the result for the background
 * script to collect — see `RESULT_KEY` in `./shared.ts`.
 */
import { extractPosting } from './extractors';
import { RESULT_KEY } from './shared';

(window as unknown as Record<string, unknown>)[RESULT_KEY] = extractPosting(
  document,
  window.location.href,
);
