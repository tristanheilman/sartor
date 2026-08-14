/**
 * Character widths for the four PDF core fonts, in 1/1000 em.
 *
 * The page-fit estimate used to divide a string's length by an assumed average
 * advance of 0.5 em. The real averages are 0.453 for Helvetica and 0.409 for
 * Times, so every line came out about ten percent short, every wrapped count
 * about ten percent high, and a resume the estimate called full measured 88%
 * on the page — leaving nearly three bullets of room unused because growth
 * believed one more would overflow.
 *
 * Extracted from the AFM tables `@react-pdf/pdfkit` already ships, for the
 * printable ASCII range. Data rather than a dependency: this module is imported
 * by the main entry, which is deliberately zod-only, and a PDF engine has no
 * business being pulled in to answer how wide a sentence is.
 *
 * Regenerate with `npm run fixtures:metrics` if the font set ever changes.
 */

/** Printable ASCII, code 32 to 126. Widths are 1/1000 em. */
const WIDTHS: Record<string, number[]> = {
  "Helvetica": [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
  "Helvetica-Bold": [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
  "Times-Roman": [250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541],
  "Times-Bold": [250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520],
};

/** Anything outside the table — accented, CJK, symbols. A conservative guess. */
const FALLBACK_WIDTH = 600;

/** Width of a string at a given size, in points. */
export function widthOf(text: string, font: string, size: number): number {
  const table = WIDTHS[font] ?? WIDTHS['Helvetica']!;
  let mille = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    mille += code >= 32 && code <= 126 ? table[code - 32]! : FALLBACK_WIDTH;
  }
  return (mille * size) / 1000;
}

/**
 * How many lines a string takes when wrapped to a width.
 *
 * Breaks on spaces, like the renderer does. A word longer than the line gets
 * its own line rather than being counted as many — over-counting a URL would
 * throw the whole page estimate off.
 */
export function wrappedLines(text: string, font: string, size: number, maxWidth: number): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (maxWidth <= 0) return 1;

  const space = widthOf(' ', font, size);
  let lines = 1;
  let used = 0;

  for (const word of trimmed.split(/\s+/)) {
    const w = widthOf(word, font, size);
    // A word starting a line stays on it however wide it is. The renderer has
    // nowhere else to put it, and counting a long URL as six lines would throw
    // the page estimate off far worse than counting it as one.
    if (used === 0) {
      used = w;
      continue;
    }
    if (used + space + w <= maxWidth) {
      used += space + w;
    } else {
      lines++;
      used = w;
    }
  }
  return lines;
}
