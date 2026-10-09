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
    let code = text.charCodeAt(i);
    // A non-breaking space is drawn with the space glyph, at its width.
    if (code === 0xa0) code = 32;
    mille += code >= 32 && code <= 126 ? table[code - 32]! : FALLBACK_WIDTH;
  }
  return (mille * size) / 1000;
}

/**
 * How many lines a string takes when wrapped to a width.
 *
 * Wrapped the way the renderer wraps it, which is not "break when the next
 * word does not fit". @react-pdf sets paragraphs with Knuth and Plass's line
 * breaker: spaces may shrink by a third of their width, so a line can run to
 * about 3% wider than the column at natural spacing and still not break, and
 * the breaks are chosen across the whole paragraph rather than one line at a
 * time. Measured the simple way, a 531pt line in a 514pt column counted as
 * two lines while the page printed one — a line of phantom height per long
 * bullet, and on a one-page resume that was most of the band of empty page
 * at the foot of it.
 *
 * Callers pass a width a little inside what the renderer actually has (see
 * `estimateHeight`), so the count may still read one line high near a break
 * but never one line low: low is how a resume runs onto a second page.
 */
export function wrappedLines(text: string, font: string, size: number, maxWidth: number): number {
  return wrappedRunLines([{ text, font }], size, maxWidth);
}

/**
 * The same, for a paragraph set in more than one font — the skills line, whose
 * group names are bold.
 */
export function wrappedRunLines(
  runs: Array<{ text: string; font: string }>,
  size: number,
  maxWidth: number,
  /**
   * Whether two runs meeting with no space between them may break there, at
   * the cost of a hyphen. @react-pdf allows it by default; the skills line
   * forbids it, with the maximum hyphenation penalty.
   */
  opts: { breakBetweenRuns?: boolean } = {},
): number {
  const breakBetweenRuns = opts.breakBetweenRuns ?? true;
  if (!runs.some((r) => r.text.trim())) return 0;
  if (maxWidth <= 0) return 1;

  const key = `${size}|${maxWidth}|${breakBetweenRuns}|${runs.map((r) => `${r.font}:${r.text}`).join('\u0000')}`;
  const cached = lineCache.get(key);
  if (cached !== undefined) return cached;

  // Past a few hundred words the line breaker's cost grows quickly, and no
  // real resume paragraph is that long. Such a paragraph is counted the
  // simple way instead, at natural spacing — which reads a line high where it
  // is wrong, never a line low.
  if (runs.reduce((n, r) => n + r.text.split(/\s+/).length, 0) > 300) {
    return naturalLines(runs, size, maxWidth);
  }

  const nodes = paragraphNodes(runs, size, breakBetweenRuns ? 600 : INFINITE);
  let tolerance = 4;
  let breaks = knuthPlass(nodes, maxWidth, tolerance);
  // As the renderer does: loosen the tolerance before giving up, then fall
  // back to filling each line as far as it will go.
  while (breaks.length === 0 && tolerance < 50) {
    tolerance += 5;
    breaks = knuthPlass(nodes, maxWidth, tolerance);
  }
  if (breaks.length === 0 || (breaks.length === 1 && breaks[0] === 0)) breaks = bestFit(nodes, maxWidth);

  // A line is a stretch between breaks with a word in it.
  let lines = 0;
  let from = 0;
  for (const end of [...breaks.slice(1), nodes.length - 1]) {
    if (nodes.slice(from, end + 1).some((n) => n.type === 'box')) lines++;
    from = end + 1;
  }
  const count = Math.max(1, lines);

  // The fit pass measures the same paragraphs hundreds of times while it
  // trims and fills. Bounded so a long session cannot grow it without limit.
  if (lineCache.size > 5000) lineCache.clear();
  lineCache.set(key, count);
  return count;
}

const lineCache = new Map<string, number>();

/**
 * Lines at natural spacing, breaking when the next word does not fit. A word
 * starting a line stays on it however wide it is — the renderer has nowhere
 * else to put it, and counting a long URL as six lines would throw the page
 * off far worse than counting it as one.
 */
function naturalLines(runs: Array<{ text: string; font: string }>, size: number, maxWidth: number): number {
  let lines = 1;
  let used = 0;
  for (const run of runs) {
    const space = widthOf(' ', run.font, size);
    for (const word of run.text.trim().split(/\s+/).filter(Boolean)) {
      const w = widthOf(word, run.font, size);
      if (used === 0) used = w;
      else if (used + space + w <= maxWidth) used += space + w;
      else {
        lines++;
        used = w;
      }
    }
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * Knuth & Plass, as @react-pdf/textkit sets it
 *
 * A port of the line breaker in @react-pdf/textkit 6.3, itself after Bram
 * Stein's JavaScript implementation (copyright 2009-2010 Bram Stein, new BSD
 * licence). Same nodes, same demerits, same fitness classes, so the estimate
 * breaks a paragraph where the renderer does. Hyphenation is off in our
 * renderer, so words are never split.
 * ------------------------------------------------------------------ */

const INFINITE = 10000;

type LineNode =
  | { type: 'box'; width: number }
  | { type: 'glue'; width: number; stretch: number; shrink: number }
  | { type: 'penalty'; width: number; penalty: number; flagged: number };

/** Words become boxes and runs of spaces become glue, split as the renderer splits them. */
function paragraphNodes(runs: Array<{ text: string; font: string }>, size: number, hyphenPenalty: number): LineNode[] {
  const syllables: Array<{ text: string; font: string }> = [];
  for (const run of runs) {
    for (const part of run.text.replace(/\s/g, ' ').split(/([ ]+)/g).filter(Boolean)) {
      syllables.push({ text: part, font: run.font });
    }
  }

  const nodes: LineNode[] = [];
  syllables.forEach(({ text, font }, i) => {
    const width = widthOf(text, font, size);
    if (text.trim() === '') {
      nodes.push({ type: 'glue', width, stretch: width / 2, shrink: width / 3 });
      return;
    }
    nodes.push({ type: 'box', width });
    // Two pieces with no space between them — a bold label and its text — may
    // break only at a cost, which the renderer prices as a hyphen.
    const next = syllables[i + 1]?.text;
    if (next !== undefined && next !== ' ') nodes.push({ type: 'penalty', width: 5, penalty: hyphenPenalty, flagged: 1 });
  });
  nodes.push({ type: 'glue', width: 0, stretch: INFINITE, shrink: 0 });
  nodes.push({ type: 'penalty', width: 0, penalty: -INFINITE, flagged: 1 });
  return nodes;
}

interface Totals {
  width: number;
  stretch: number;
  shrink: number;
}

interface Breakpoint {
  position: number;
  demerits: number;
  line: number;
  fitnessClass: number;
  totals: Totals;
  previous: Breakpoint | null;
}

function knuthPlass(nodes: LineNode[], lineLength: number, tolerance: number): number[] {
  const active: Breakpoint[] = [
    { position: 0, demerits: 0, line: 0, fitnessClass: 0, totals: { width: 0, stretch: 0, shrink: 0 }, previous: null },
  ];
  const sum: Totals = { width: 0, stretch: 0, shrink: 0 };

  /** How far the line from `from` to `end` has to stretch (+) or shrink (-). */
  const ratio = (end: number, from: Breakpoint): number => {
    let width = sum.width - from.totals.width;
    const node = nodes[end]!;
    if (node.type === 'penalty') width += node.width;
    if (width < lineLength) {
      const stretch = sum.stretch - from.totals.stretch;
      return stretch > 0 ? (lineLength - width) / stretch : INFINITE;
    }
    if (width > lineLength) {
      const shrink = sum.shrink - from.totals.shrink;
      return shrink > 0 ? (lineLength - width) / shrink : INFINITE;
    }
    return 0;
  };

  /** Totals as they stand after any glue following a break. */
  const totalsAfter = (index: number): Totals => {
    const out = { ...sum };
    for (let i = index; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.type === 'glue') {
        out.width += node.width;
        out.stretch += node.stretch;
        out.shrink += node.shrink;
      } else if (node.type === 'box' || (node.type === 'penalty' && node.penalty === -INFINITE && i > index)) {
        break;
      }
    }
    return out;
  };

  const consider = (node: LineNode, index: number) => {
    let i = 0;
    while (i < active.length) {
      let currentLine = 0;
      const candidates: Array<{ from?: Breakpoint; demerits: number }> = [0, 1, 2, 3].map(() => ({
        demerits: Infinity,
      }));

      while (i < active.length) {
        const from = active[i]!;
        currentLine = from.line + 1;
        const r = ratio(index, from);
        const forced = node.type === 'penalty' && node.penalty === -INFINITE;

        let removed = false;
        if (r < -1 || forced) {
          active.splice(i, 1);
          removed = true;
        }

        if (r >= -1 && r <= tolerance) {
          const badness = 100 * Math.abs(r) ** 3;
          let demerits = (10 + badness) ** 2;
          if (node.type === 'penalty' && node.penalty >= 0) demerits += node.penalty ** 2;
          else if (node.type === 'penalty' && node.penalty !== -INFINITE) demerits -= node.penalty ** 2;

          const prev = nodes[from.position]!;
          if (node.type === 'penalty' && prev.type === 'penalty') demerits += 100 * node.flagged * prev.flagged;

          const fitnessClass = r < -0.5 ? 0 : r <= 0.5 ? 1 : r <= 1 ? 2 : 3;
          if (Math.abs(fitnessClass - from.fitnessClass) > 1) demerits += 3000;
          demerits += from.demerits;

          if (demerits < candidates[fitnessClass]!.demerits) candidates[fitnessClass] = { from, demerits };
        }

        if (!removed) i++;
        if (i < active.length && active[i]!.line >= currentLine) break;
      }

      const totals = totalsAfter(index);
      const added: Breakpoint[] = [];
      candidates.forEach((c, fitnessClass) => {
        if (!c.from) return;
        added.push({ position: index, demerits: c.demerits, line: c.from.line + 1, fitnessClass, totals, previous: c.from });
      });
      active.splice(i, 0, ...added);
      i += added.length;
    }
  };

  nodes.forEach((node, index) => {
    if (node.type === 'box') {
      sum.width += node.width;
    } else if (node.type === 'glue') {
      if (index > 0 && nodes[index - 1]!.type === 'box') consider(node, index);
      sum.width += node.width;
      sum.stretch += node.stretch;
      sum.shrink += node.shrink;
    } else if (node.penalty !== INFINITE) {
      consider(node, index);
    }
  });

  if (!active.length) return [];
  let best = active[0]!;
  for (const a of active) if (a.demerits < best.demerits) best = a;
  const positions: number[] = [];
  for (let b: Breakpoint | null = best; b; b = b.previous) positions.push(b.position);
  return positions.reverse();
}

/** The renderer's fallback when no setting is good enough: fill each line as far as it goes. */
function bestFit(nodes: LineNode[], lineLength: number): number[] {
  const breaks = [0];
  let rest = nodes;
  let count = 0;

  while (rest.length > 0) {
    let position: number | null = null;
    let leastBad = Infinity;
    const sum = { width: 0, stretch: 0, shrink: 0 };
    let overflowed = false;

    for (let i = 0; i < rest.length; i++) {
      const node = rest[i]!;
      if (node.type === 'box') sum.width += node.width;
      if (node.type === 'glue') {
        sum.width += node.width;
        sum.stretch += node.stretch;
        sum.shrink += node.shrink;
      }
      let j = i + 1;
      while (j < rest.length && rest[j]!.type !== 'box') j++;
      const lineEnd = rest[j - 1];
      const hyphen = lineEnd?.type === 'penalty' ? lineEnd.width : 0;

      if (sum.width - sum.shrink + hyphen > lineLength) {
        if (position === null) {
          let k = i === 0 ? 1 : i;
          while (k < rest.length && rest[k]!.type !== 'box') k++;
          position = k - 1;
        }
        overflowed = true;
        break;
      }

      if (node.type !== 'box') {
        let r = 0;
        if (sum.width < lineLength) {
          const own = node.type === 'glue' ? node.stretch : 0;
          r = own && sum.stretch - own > 0 ? (lineLength - sum.width) / sum.stretch : INFINITE;
        } else if (sum.width > lineLength) {
          const own = node.type === 'glue' ? node.shrink : 0;
          r = own && sum.shrink - own > 0 ? (lineLength - sum.width) / sum.shrink : INFINITE;
        }
        const bad = 100 * Math.abs(r) ** 3 + (node.type === 'penalty' ? node.penalty : 0);
        if (leastBad >= bad) {
          position = i;
          leastBad = bad;
        }
      }
    }

    if (overflowed && position !== null) {
      count += position;
      breaks.push(count);
      rest = rest.slice(position + 1);
      count++;
    } else {
      rest = [];
    }
  }
  return breaks;
}
