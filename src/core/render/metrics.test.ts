import { describe, it, expect } from 'vitest';
import { widthOf, wrappedLines } from './metrics';

/**
 * Measured against the renderer's own font tables.
 *
 * The estimate previously divided a string's length by an assumed 0.5 em
 * average advance. Helvetica's real average over ordinary prose is 0.453 and
 * Times' is 0.409, so lines came out about ten percent short and wrapped counts
 * ten percent high — which is why a page the estimate called full measured 88%
 * and growth refused bullets that had room.
 */

const SAMPLE =
  'Owned the release cycle for the Figure1 mobile app and served as the primary source of knowledge on it.';

describe('measuring a string', () => {
  it('agrees with the renderer on a real bullet', () => {
    // 466.4pt at 10pt Helvetica, from @react-pdf/pdfkit's own measurement.
    expect(widthOf(SAMPLE, 'Helvetica', 10)).toBeCloseTo(466.4, 0);
  });

  it('knows Times is narrower than Helvetica', () => {
    expect(widthOf(SAMPLE, 'Times-Roman', 10)).toBeLessThan(widthOf(SAMPLE, 'Helvetica', 10));
  });

  it('knows bold is wider', () => {
    expect(widthOf(SAMPLE, 'Helvetica-Bold', 10)).toBeGreaterThan(widthOf(SAMPLE, 'Helvetica', 10));
  });

  it('scales with size', () => {
    expect(widthOf(SAMPLE, 'Helvetica', 20)).toBeCloseTo(widthOf(SAMPLE, 'Helvetica', 10) * 2, 5);
  });

  it('does not treat every character as the same width', () => {
    // The whole point. An "i" is not an "M".
    expect(widthOf('M', 'Helvetica', 10)).toBeGreaterThan(widthOf('i', 'Helvetica', 10) * 3);
  });

  it('falls back for characters outside the table', () => {
    // Em dashes and accents appear in real resumes and must not measure as zero.
    expect(widthOf('—', 'Helvetica', 10)).toBeGreaterThan(0);
    expect(widthOf('café', 'Helvetica', 10)).toBeGreaterThan(widthOf('caf', 'Helvetica', 10));
  });

  it('falls back for a font it does not know', () => {
    expect(widthOf(SAMPLE, 'Comic Sans', 10)).toBe(widthOf(SAMPLE, 'Helvetica', 10));
  });

  it('measures nothing as nothing', () => {
    expect(widthOf('', 'Helvetica', 10)).toBe(0);
  });
});

describe('wrapping to a column', () => {
  it('fits a short line on one line', () => {
    expect(wrappedLines('Shipped it.', 'Helvetica', 10, 528)).toBe(1);
  });

  it('wraps a bullet that overruns the column', () => {
    // 466pt of text in a 300pt column.
    expect(wrappedLines(SAMPLE, 'Helvetica', 10, 300)).toBe(2);
  });

  it('gets the count right at the boundary', () => {
    const w = widthOf(SAMPLE, 'Helvetica', 10);
    expect(wrappedLines(SAMPLE, 'Helvetica', 10, w + 1)).toBe(1);
    expect(wrappedLines(SAMPLE, 'Helvetica', 10, w - 1)).toBe(2);
  });

  it('gives a word longer than the column one line, not many', () => {
    // A URL with no spaces. Counting it as six lines would throw the page off
    // far worse than counting it as one.
    const url = 'https://github.com/tristanheilman/react-native-island/blob/main/README.md';
    expect(wrappedLines(url, 'Helvetica', 10, 80)).toBe(1);
  });

  it('counts an empty string as no lines at all', () => {
    expect(wrappedLines('', 'Helvetica', 10, 528)).toBe(0);
    expect(wrappedLines('   ', 'Helvetica', 10, 528)).toBe(0);
  });

  it('needs more lines in a narrower column', () => {
    const wide = wrappedLines(SAMPLE, 'Helvetica', 10, 528);
    const narrow = wrappedLines(SAMPLE, 'Helvetica', 10, 200);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('is not fooled by the old assumption', () => {
    // At 0.5 em per character this bullet was counted as two lines in a
    // 528pt column. It is one.
    expect(wrappedLines(SAMPLE, 'Helvetica', 10, 528)).toBe(1);
    expect(Math.ceil(SAMPLE.length / 105)).toBe(1);
  });
});
