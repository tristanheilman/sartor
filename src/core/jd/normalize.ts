/**
 * Job description normalisation.
 *
 * Postings arrive as pasted text, as HTML from an ATS JSON endpoint, or (later)
 * from the browser extension. They all reduce to the same shape before anything
 * downstream touches them.
 */

export interface JobDescription {
  title: string;
  company: string;
  location: string;
  url: string;
  /** Plain text, normalised whitespace. This is what the model and the
   * coverage report both read. */
  text: string;
  /** Where this came from, shown in the UI so provenance is never implicit. */
  source: 'paste' | 'greenhouse' | 'lever' | 'ashby' | 'extension';
}

/** Converts posting HTML to readable plain text without a DOM parser
 * dependency, preserving list and paragraph breaks that carry meaning. */
export function htmlToText(html: string): string {
  const withBreaks = html
    // Strip script/style first, so their contents can never leak into the text.
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // `<li>` supplies its own leading break, so `</li>` must not add another.
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\s*(p|div|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(withBreaks);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

export function fromPaste(raw: string): JobDescription {
  const text = normalizeText(raw.includes('<') && /<\/?[a-z]/i.test(raw) ? htmlToText(raw) : raw);
  return {
    title: guessTitle(text),
    company: '',
    location: '',
    url: '',
    text,
    source: 'paste',
  };
}

/** First non-empty line, when it is short enough to plausibly be a title. */
function guessTitle(text: string): string {
  const first = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  return first.length > 0 && first.length <= 90 ? first : '';
}

export function isEmptyJd(jd: JobDescription | null): boolean {
  return !jd || jd.text.trim().length < 40;
}
