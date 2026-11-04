/**
 * Scaffold only — see ../README.md.
 *
 * Injected into the active tab on the action click (not implemented yet —
 * see background.js). Extracts the posting from the page the user already
 * has open; handing the result off to the Sartor tab via `bridge.ts` is a
 * separate, not-yet-built step.
 */
import { extractPosting } from './extractors/index';

export function run(): ReturnType<typeof extractPosting> {
  return extractPosting(document, location.href);
}
