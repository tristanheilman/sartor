import { describe, it, expect } from 'vitest';
import { TEMPLATES } from '../render/templates';
import { printedLines } from '../render/model';
import { measureSummary, summaryCharacterBudget, summaryLineBudget } from './summary';

/**
 * Summaries from three unrelated fields, none of them the sentence the
 * character width is measured on, with very different word lengths.
 */
const PROSE = [
  'Data engineer who designs streaming pipelines and the warehouse models downstream of them, with a habit of making the on-call rotation quieter than it was before, and of writing down why each decision was made so the next person can change it safely.',
  'Product designer focused on research-led interaction design for healthcare tools, comfortable moving between discovery interviews, prototypes and production component libraries, and accountable for accessibility from the first sketch onward.',
  'Nurse manager with a decade on surgical wards who built the rota, the handover and the training plan that cut agency shifts by half, and who still takes a full patient list one day a week to keep close to the work.',
];

/** As much of `text`, repeated, as fits in `n` characters, ending on a whole word. */
function upTo(text: string, n: number): string {
  const long = `${text} ${text} ${text}`;
  return long.slice(0, n).replace(/\s+\S*$/, '');
}

describe('the summary line budget', () => {
  it('is three printed lines on one page and four on two', () => {
    expect(summaryLineBudget(1)).toBe(3);
    expect(summaryLineBudget(2)).toBe(4);
  });

  it('gives a character count that prints within it, in every template', () => {
    for (const t of TEMPLATES) {
      for (const pages of [1, 2] as const) {
        const budget = summaryCharacterBudget(pages, t);
        for (const text of PROSE) {
          expect(printedLines(upTo(text, budget), t), `${t.id}, ${pages} page(s)`).toBeLessThanOrEqual(summaryLineBudget(pages));
        }
      }
    }
  });

  it('does not leave a line of it unused', () => {
    // A count so cautious that it prints on two lines of three would cut the
    // summary short for nothing.
    for (const t of TEMPLATES) {
      for (const text of PROSE) {
        expect(printedLines(upTo(text, summaryCharacterBudget(1, t)), t), t.id).toBe(3);
      }
    }
  });

  it('is fewer characters in a roomier template', () => {
    const at = (id: string) => summaryCharacterBudget(1, TEMPLATES.find((t) => t.id === id)!);
    expect(at('roomy')).toBeLessThan(at('classic'));
    expect(at('compact')).toBeGreaterThan(at('classic'));
  });
});

describe('measuring a summary', () => {
  const classic = TEMPLATES.find((t) => t.id === 'classic')!;

  it('says when it runs over', () => {
    const long = PROSE.join(' ');
    expect(measureSummary(long, 1, classic)).toMatchObject({ budget: 3, over: true });
    expect(measureSummary(long, 1, classic).lines).toBeGreaterThan(3);
  });

  it('does not count a summary within budget as over', () => {
    expect(measureSummary(PROSE[0]!, 1, classic)).toEqual({ lines: 3, budget: 3, over: false });
  });

  it('measures no summary as no lines', () => {
    expect(measureSummary('  ', 1, classic)).toEqual({ lines: 0, budget: 3, over: false });
  });

  it('allows a longer one on two pages', () => {
    const fourLines = upTo(PROSE[1]!, summaryCharacterBudget(2, classic));
    expect(measureSummary(fourLines, 1, classic).over).toBe(true);
    expect(measureSummary(fourLines, 2, classic).over).toBe(false);
  });
});
