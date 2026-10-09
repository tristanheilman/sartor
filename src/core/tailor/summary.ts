import { DEFAULT_PAGE_METRICS, charactersPerLine, printedLines, type PageMetrics } from '../render/model';

/**
 * How many printed lines the summary may take.
 *
 * It was bounded only in sentences, and a sentence has no length: one-page
 * plans came back with summaries of four and five lines, and on a full page
 * every line over is a bullet's worth of room the trim then has to find
 * elsewhere. Three lines is enough to say what kind of professional this is
 * and what they are for; a second page buys one more.
 */
export function summaryLineBudget(pageTarget: 1 | 2): number {
  return pageTarget === 1 ? 3 : 4;
}

/**
 * The same budget in characters, which is what a writer can aim at.
 *
 * Nine-tenths of the lines' full width: a paragraph's breaks fall between
 * words, so its lines are rarely full, and a summary written to the last
 * character of the budget would spill onto one more.
 */
export function summaryCharacterBudget(pageTarget: 1 | 2, template: PageMetrics = DEFAULT_PAGE_METRICS): number {
  const full = summaryLineBudget(pageTarget) * charactersPerLine(template);
  return Math.floor((full * 0.9) / 10) * 10;
}

export interface SummaryLength {
  /** Lines the summary prints on. */
  lines: number;
  budget: number;
  over: boolean;
}

/** The summary as it prints, against its budget. */
export function measureSummary(text: string, pageTarget: 1 | 2, template: PageMetrics = DEFAULT_PAGE_METRICS): SummaryLength {
  const lines = text.trim() ? printedLines(text, template) : 0;
  const budget = summaryLineBudget(pageTarget);
  return { lines, budget, over: lines > budget };
}
