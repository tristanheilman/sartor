/**
 * Turning positioned glyph runs back into lines of reading-order text.
 *
 * pdf.js hands back text runs with coordinates, not lines. Reassembling them is
 * where most real-world extraction goes wrong, and both failure modes below
 * were found by running an actual resume through the extractor rather than by
 * reasoning about it:
 *
 *   1. **Ligatures split a word into three runs.** "significantly" arrives as
 *      `"…signi"`, `"fi"`, `"cantly…"` — three runs sitting flush against each
 *      other, because the `fi` glyph comes from a different font programme.
 *      Joining every run in a row with a space produces "signi fi cantly",
 *      which then poisons the profile, the guard lexicon, and every keyword
 *      comparison downstream.
 *
 *   2. **Two-column layouts interleave.** A sidebar shares vertical positions
 *      with the main column, so bucketing on `y` alone merges "Northwind Payments,
 *      Austin, TX" with "github.com/…" onto one line. Resume templates with
 *      a skills sidebar are extremely common, and this quietly shreds them.
 */

export interface PositionedText {
  text: string;
  /** Left edge, PDF units, origin bottom-left. */
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  /** Glyph height, used as a stand-in for font size. */
  height: number;
}

/** Runs closer than this fraction of the font size are one word. */
const SPACE_RATIO = 0.18;

/** A gutter narrower than this is word spacing, not a column boundary. */
const MIN_GUTTER = 18;

/** Rows within this many units of each other are the same line. */
const ROW_TOLERANCE = 2;

/**
 * Finds vertical corridors that no text crosses.
 *
 * A few items legitimately span the whole page — a horizontal rule, a header —
 * so a corridor is allowed to be crossed by a small number of them rather than
 * requiring it to be perfectly empty. Without that tolerance a single full-width
 * rule would hide the gutter and collapse the whole page back to one column.
 */
function findGutters(items: PositionedText[]): number[] {
  if (items.length < 12) return [];

  const left = Math.min(...items.map((i) => i.x));
  const right = Math.max(...items.map((i) => i.x + i.width));
  if (right - left < MIN_GUTTER * 3) return [];

  const BIN = 4;
  const bins = Math.ceil((right - left) / BIN);
  const coverage = new Array<number>(bins).fill(0);

  for (const item of items) {
    const from = Math.max(0, Math.floor((item.x - left) / BIN));
    const to = Math.min(bins - 1, Math.floor((item.x + item.width - left) / BIN));
    for (let b = from; b <= to; b++) coverage[b] = (coverage[b] ?? 0) + 1;
  }

  // Generous, because the items that cross a gutter are section rules and
  // banner headings, and a page only has a handful of either. Too strict and a
  // single divider hides the gutter; too loose and justified body text starts
  // looking like two columns. The floor of 2 matters on short pages, where a
  // percentage rounds down to nothing.
  const tolerance = Math.max(2, Math.ceil(items.length * 0.03));
  const gutters: number[] = [];
  let runStart: number | null = null;

  for (let b = 0; b <= bins; b++) {
    const empty = b < bins && (coverage[b] ?? 0) <= tolerance;

    if (empty && runStart === null) runStart = b;

    if (!empty && runStart !== null) {
      const from = left + runStart * BIN;
      const to = left + b * BIN;
      // Ignore margins: a corridor touching either edge is whitespace, not a
      // column boundary.
      if (to - from >= MIN_GUTTER && runStart > 0 && b < bins) {
        gutters.push((from + to) / 2);
      }
      runStart = null;
    }
  }

  return gutters;
}

/** Splits items into columns at the given boundaries, by their left edge. */
function intoColumns(items: PositionedText[], gutters: number[]): PositionedText[][] {
  if (!gutters.length) return [items];

  const columns: PositionedText[][] = Array.from({ length: gutters.length + 1 }, () => []);
  for (const item of items) {
    // A full-width rule starts in the first column and belongs to it, which
    // keeps section dividers attached to the content they divide.
    let index = 0;
    while (index < gutters.length && item.x >= (gutters[index] ?? Infinity)) index++;
    columns[index]?.push(item);
  }

  // A column holding almost nothing is noise — a stray glyph past the gutter,
  // not a real column. Fold it back rather than emitting a fragment.
  return columns.filter((c) => c.length > 1);
}

/** One column's runs, as lines, top to bottom. */
function columnLines(items: PositionedText[]): string[] {
  const rows = new Map<number, PositionedText[]>();

  for (const item of items) {
    const y = Math.round(item.y);
    const bucket = [...rows.keys()].find((k) => Math.abs(k - y) <= ROW_TOLERANCE) ?? y;
    rows.set(bucket, [...(rows.get(bucket) ?? []), item]);
  }

  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // PDF origin is bottom-left.
    .map(([, row]) => {
      const sorted = [...row].sort((a, b) => a.x - b.x);

      let line = '';
      let previous: PositionedText | null = null;

      for (const item of sorted) {
        if (previous) {
          const gap = item.x - (previous.x + previous.width);
          // Only a real horizontal gap is a space. Ligature runs butt straight
          // up against their neighbours and must not be separated.
          const threshold = SPACE_RATIO * (item.height || previous.height || 10);
          if (gap > threshold) line += ' ';
        }
        line += item.text;
        previous = item;
      }

      return line.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean);
}

/**
 * Positioned runs to reading-order lines.
 *
 * Columns are emitted one after another, left to right — a sidebar's contents
 * end up after the main column rather than woven through it. That is not the
 * visual order, but it is the order the text makes sense in, which is what
 * every downstream reader needs.
 */
export function assembleLines(items: PositionedText[]): string[] {
  const usable = items.filter((i) => i.text.trim());
  if (!usable.length) return [];

  const columns = intoColumns(usable, findGutters(usable));
  return columns.flatMap((column) => columnLines(column));
}
