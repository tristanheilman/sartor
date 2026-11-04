/**
 * On the action button's click:
 *
 *   1. Inject the content script into the clicked tab — granted by the click
 *      itself (`activeTab`), not a standing host permission.
 *   2. Read back what it found.
 *   3. Open the Sartor app with the posting in a URL fragment, which a
 *      GitHub Pages server never sees. `src/ui/postingHandoff.ts` on the app
 *      side takes it from there: handing it to an already-open Sartor tab
 *      over a same-origin `BroadcastChannel` when there is one, because that
 *      tab already has a model key in `sessionStorage` and a fresh one does
 *      not.
 *
 * Note what is deliberately absent: any network permission. This extension
 * can never send a page anywhere itself — see ../README.md.
 */
import type { ExtractedPosting } from './extractors/generic';
import { RESULT_KEY } from './shared';
import { MAX_FRAGMENT_LENGTH } from '../../src/ui/postingHandoff';

const APP_URL_PROD = 'https://tristanheilman.github.io/sartor/';
/** Swap in for `APP_URL_PROD` below when developing against `npm run dev`. */
export const APP_URL_DEV = 'http://localhost:5173/';
const APP_URL = APP_URL_PROD;

chrome.action.onClicked.addListener((tab) => {
  void handleClick(tab);
});

async function handleClick(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;

  await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/content.js'] });

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (key: string) => {
      const win = window as unknown as Record<string, unknown>;
      const result = win[key];
      delete win[key];
      return (result ?? null) as ExtractedPosting | null;
    },
    args: [RESULT_KEY],
  });

  const posting = injection?.result ?? null;
  if (!posting) {
    showPasteInstead(tabId, "Couldn't read a posting on this page — paste it into Sartor instead.");
    return;
  }

  const fragment = encodeURIComponent(JSON.stringify(posting));
  if (fragment.length > MAX_FRAGMENT_LENGTH) {
    showPasteInstead(tabId, 'That posting is too long to hand off — paste it into Sartor instead.');
    return;
  }

  await chrome.tabs.create({ url: `${APP_URL}#posting=${fragment}` });
}

function showPasteInstead(tabId: number, title: string): void {
  void chrome.action.setBadgeText({ tabId, text: '!' });
  void chrome.action.setBadgeBackgroundColor({ tabId, color: '#b45309' });
  void chrome.action.setTitle({ tabId, title });
}
