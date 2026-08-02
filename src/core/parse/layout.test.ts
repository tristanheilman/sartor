import { describe, it, expect } from 'vitest';
import { assembleLines, type PositionedText } from './layout';

/**
 * Line reassembly, tested on synthetic geometry.
 *
 * Both cases here came from running a real two-column resume through the
 * extractor. They are reproduced as coordinates rather than as a PDF so the
 * tests state the actual condition — "these runs touch", "these are separated
 * by an empty corridor" — instead of hiding it inside a binary.
 */

const row = (y: number, parts: Array<[string, number, number]>): PositionedText[] =>
  parts.map(([text, x, width]) => ({ text, x, y, width, height: 10 }));

/** Runs laid out left to right with no gap, as a ligature split produces. */
function touching(y: number, x: number, parts: string[]): PositionedText[] {
  let cursor = x;
  return parts.map((text) => {
    const width = text.length * 4.5;
    const item = { text, x: cursor, y, width, height: 10 };
    cursor += width;
    return item;
  });
}

describe('ligatures', () => {
  it('does not insert a space between runs that touch', () => {
    // "significantly" arrives as three runs because the `fi` glyph comes from a
    // different font programme. This is the exact shape pdf.js produced.
    const items = touching(700, 72.6, ['and background task handling, signi', 'fi', 'cantly reducing']);
    expect(assembleLines(items)).toEqual(['and background task handling, significantly reducing']);
  });

  it('still inserts a space across a real gap', () => {
    const items = row(700, [
      ['Lead Mobile App Developer', 54, 120],
      ['05/2022 – Present', 300, 80],
    ]);
    expect(assembleLines(items)).toEqual(['Lead Mobile App Developer 05/2022 – Present']);
  });

  it('scales the space threshold with the font size', () => {
    // A 24pt heading has wider natural spacing than 8pt body text; a fixed
    // threshold would either split headings or glue small text together.
    // A 24pt space is ~7 units wide; a 10pt space is ~2.8. Both must read as
    // spaces, and neither may glue words together.
    const big: PositionedText[] = [
      { text: 'Jordan', x: 50, y: 700, width: 84, height: 24 },
      { text: 'Avery', x: 141, y: 700, width: 84, height: 24 },
    ];
    expect(assembleLines(big)).toEqual(['Jordan Avery']);
  });
});

describe('columns', () => {
  /** A main column at x≈50 and a sidebar at x≈400, sharing vertical positions. */
  const twoColumn: PositionedText[] = [
    ...row(700, [['Northwind Payments, Austin, TX', 54, 130]]),
    ...row(700, [['github.com/jordanavery', 400, 110]]),
    ...row(688, [['Lead Mobile App Developer', 54, 130]]),
    ...row(688, [['npmjs.com/~jordanavery', 400, 110]]),
    ...row(676, [['Supported a user base of 20k+ users', 54, 170]]),
    ...row(676, [['SKILLS', 400, 40]]),
    ...row(664, [['Refactored driver tracking logic', 54, 160]]),
    ...row(664, [['Javascript / Typescript', 400, 100]]),
    ...row(652, [['Co-led the Stripe integration', 54, 150]]),
    ...row(652, [['React / React Native', 400, 95]]),
    ...row(640, [['Developed CI/CD pipelines', 54, 140]]),
    ...row(640, [['Swift / Objective-C', 400, 90]]),
  ];

  it('reads each column through before starting the next', () => {
    const lines = assembleLines(twoColumn);

    // Not the visual order, but the order the text makes sense in.
    expect(lines).toEqual([
      'Northwind Payments, Austin, TX',
      'Lead Mobile App Developer',
      'Supported a user base of 20k+ users',
      'Refactored driver tracking logic',
      'Co-led the Stripe integration',
      'Developed CI/CD pipelines',
      'github.com/jordanavery',
      'npmjs.com/~jordanavery',
      'SKILLS',
      'Javascript / Typescript',
      'React / React Native',
      'Swift / Objective-C',
    ]);
  });

  it('never merges a sidebar entry onto a main-column line', () => {
    for (const line of assembleLines(twoColumn)) {
      expect(line).not.toMatch(/Austin, TX github/);
    }
  });

  it('is not fooled out of finding the gutter by a full-width rule', () => {
    // Section dividers span both columns. A strict "no item crosses this
    // corridor" rule would miss the gutter entirely because of them.
    const withRule = [
      ...twoColumn,
      ...row(694, [['_'.repeat(70), 54, 460]]),
      ...row(658, [['_'.repeat(70), 54, 460]]),
    ];
    const lines = assembleLines(withRule);
    expect(lines).not.toContain('Northwind Payments, Austin, TX github.com/jordanavery');
    expect(lines.filter((l) => l.startsWith('___'))).toHaveLength(2);
  });
});

describe('single-column documents', () => {
  it('are left in reading order, top to bottom', () => {
    const items = [
      ...row(700, [['Jordan Avery', 54, 80]]),
      ...row(680, [['EXPERIENCE', 54, 70]]),
      ...row(660, [['Staff Engineer, Northwind', 54, 140]]),
    ];
    expect(assembleLines(items)).toEqual([
      'Jordan Avery',
      'EXPERIENCE',
      'Staff Engineer, Northwind',
    ]);
  });

  it('does not invent a column from ordinary word spacing', () => {
    // Wide word gaps inside a justified line must not read as a gutter.
    const items = row(700, [
      ['Led', 54, 20],
      ['the', 90, 20],
      ['migration', 130, 50],
    ]);
    expect(assembleLines(items)).toEqual(['Led the migration']);
  });

  it('ignores runs that are only whitespace', () => {
    const items = [...row(700, [['  ', 54, 5], ['Jordan Avery', 60, 80]])];
    expect(assembleLines(items)).toEqual(['Jordan Avery']);
  });

  it('returns nothing for an empty page', () => {
    expect(assembleLines([])).toEqual([]);
  });
});
