/**
 * Runs on the clicked tab, on a user gesture (`activeTab`), and nothing else.
 * It reads the job description from the page using the same generic
 * extractor the fixtures are tested against, and leaves the result for the
 * background script to collect — see `RESULT_KEY` in `./shared.ts`.
 */
import { extractGeneric } from './extractors/generic';
import { RESULT_KEY } from './shared';

(window as unknown as Record<string, unknown>)[RESULT_KEY] = extractGeneric(
  document,
  window.location.href,
);
