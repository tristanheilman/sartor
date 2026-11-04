/** The `window` property the content script leaves the extraction result in,
 * for the background script's follow-up `executeScript` call to read back.
 * A file-based content script's own completion value is not reliably
 * returned by `chrome.scripting.executeScript`, so the result travels
 * through a global instead. */
export const RESULT_KEY = '__sartorExtractedPosting';
