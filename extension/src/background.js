/**
 * Scaffold only — see ../README.md.
 *
 * The intended flow, when this is implemented:
 *
 *   1. User clicks the action button while looking at a job posting.
 *   2. We inject the content script into that tab (activeTab, granted by the
 *      click — not a standing host permission).
 *   3. The content script extracts the job description text and nothing else.
 *   4. We hand it to an open Sartor tab via postMessage.
 *
 * Note what is deliberately absent: any network permission. This extension can
 * never send a page anywhere. That is the whole point — the alternative design,
 * a server-side scraping proxy, is rejected in the README for reasons that are
 * mostly about not having a server at all.
 */

chrome.action.onClicked.addListener(() => {
  // Intentionally unimplemented.
  console.info('[sartor] Extension is a scaffold. Paste the posting into the web app instead.');
});
