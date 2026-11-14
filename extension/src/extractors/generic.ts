/**
 * Readability-style fallback extractor. Works on any page's DOM, without
 * knowing anything about the site it runs on, so it is the extractor every
 * posting can fall back to while per-site extractors are still being written.
 *
 * It reads only the block of content it decides is the posting, plus the
 * page's title and meta tags — never the rest of the page.
 */
import { htmlToText, normalizeText } from '../../../src/core/jd/normalize';

export interface ExtractedPosting {
  title: string;
  company: string;
  location: string;
  url: string;
  text: string;
}

const REMOVED_TAGS = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'form']);

/** Elements whose own text is what the scoring heuristic rewards. */
const TEXT_UNIT_SELECTOR = 'p, li, blockquote, pre, td';

const KEYWORD_PATTERN = /job|description|posting/i;

/** Below this, a block is too short to plausibly be a full posting. */
const MIN_TEXT_LENGTH = 300;

/** Above this fraction of text sitting inside `<a>` tags, a block is a list
 * of links (nav, related postings, search results) rather than a posting. */
const MAX_LINK_DENSITY = 0.5;

export function extractGeneric(doc: Document, url: string): ExtractedPosting | null {
  const root = doc.body.cloneNode(true) as HTMLElement;
  stripNoise(root);

  const candidate = pickBestCandidate(root);
  if (!candidate) return null;

  const text = normalizeText(htmlToText(candidate.innerHTML));
  if (text.length < MIN_TEXT_LENGTH) return null;
  if (linkDensity(candidate) > MAX_LINK_DENSITY) return null;

  return {
    title: extractTitle(doc),
    company: '',
    location: '',
    url,
    text,
  };
}

function stripNoise(root: HTMLElement): void {
  for (const tag of REMOVED_TAGS) {
    for (const el of Array.from(root.getElementsByTagName(tag))) {
      el.remove();
    }
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (isHidden(el)) el.remove();
  }
}

function isHidden(el: Element): boolean {
  if (el.hasAttribute('hidden')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const style = el.getAttribute('style') ?? '';
  return /display\s*:\s*none/i.test(style) || /visibility\s*:\s*hidden/i.test(style);
}

/** Readability's classic trick: score the small elements that actually hold
 * prose, then let that score flow up a few levels of ancestor, so the
 * *container* of the prose — not a single paragraph — ends up top-ranked. */
function pickBestCandidate(root: HTMLElement): Element | null {
  const scores = new Map<Element, number>();

  for (const unit of Array.from(root.querySelectorAll(TEXT_UNIT_SELECTOR))) {
    const text = (unit.textContent ?? '').trim();
    if (text.length < 25) continue;

    const score = 1 + Math.min(Math.floor(text.length / 100), 3) + Math.min(countCommas(text), 5);

    let ancestor: Element | null = unit.parentElement;
    let level = 0;
    while (ancestor && level < 3) {
      const divisor = level === 0 ? 1 : level === 1 ? 2 : 4;
      scores.set(ancestor, (scores.get(ancestor) ?? 0) + score / divisor);
      ancestor = ancestor.parentElement;
      level++;
    }
  }

  for (const [el, score] of scores) {
    if (matchesKeyword(el)) scores.set(el, score * 1.5);
  }

  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, score] of scores) {
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

function countCommas(text: string): number {
  return text.split(',').length - 1;
}

function matchesKeyword(el: Element): boolean {
  const haystack = `${el.id} ${el.className} ${el.getAttribute('aria-label') ?? ''}`;
  return KEYWORD_PATTERN.test(haystack);
}

function linkDensity(el: Element): number {
  const totalText = (el.textContent ?? '').trim();
  if (totalText.length === 0) return 1;
  let linkText = 0;
  for (const anchor of Array.from(el.querySelectorAll('a'))) {
    linkText += (anchor.textContent ?? '').trim().length;
  }
  return linkText / totalText.length;
}

function extractTitle(doc: Document): string {
  const h1 = doc.querySelector('h1');
  const h1Text = h1?.textContent?.trim();
  if (h1Text) return h1Text;

  const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  return ogTitle?.trim() ?? '';
}
