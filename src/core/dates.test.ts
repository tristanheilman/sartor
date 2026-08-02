import { describe, it, expect } from 'vitest';
import { isOngoing, monthsSince, rangesOverlap, toMonths } from './dates';

/**
 * Resume dates are free text, and getting one wrong is not cosmetic: a format
 * this could not read once made two stints at the same employer fail to match,
 * so a merge that should have corrected an end date added a duplicate employer
 * instead.
 */

describe('reading a date', () => {
  it.each([
    ['2021-03', 2021 * 12 + 2],
    ['2021-3', 2021 * 12 + 2],
    ['2021-03-15', 2021 * 12 + 2],
    ['05/2022', 2022 * 12 + 4],
    ['5/2022', 2022 * 12 + 4],
    ['05/15/2022', 2022 * 12 + 4],
    ['March 2021', 2021 * 12 + 2],
    ['Mar 2021', 2021 * 12 + 2],
    ['Sept 2021', 2021 * 12 + 8],
    ['2019', 2019 * 12],
  ])('%s', (raw, expected) => {
    expect(toMonths(raw)).toBe(expected);
  });

  it.each(['', '  ', 'Present', 'current', 'ongoing', 'sometime in the spring'])(
    'has no month: %s',
    (raw) => {
      expect(toMonths(raw)).toBeNull();
    },
  );

  it('treats the words a resume uses for "still there" as ongoing', () => {
    for (const v of ['', 'Present', 'present', 'Current', 'now', 'ongoing']) {
      expect(isOngoing(v), v).toBe(true);
    }
    expect(isOngoing('2021-03')).toBe(false);
  });
});

describe('overlap', () => {
  const range = (startDate: string, endDate: string) => ({ startDate, endDate });

  it('matches two stints written in different formats', () => {
    // The exact failure: the profile said 05/2022, the incoming source said the
    // same role in the same format, and a YYYY-MM-only parser saw neither.
    expect(rangesOverlap(range('05/2022', ''), range('05/2022', '11/2025'))).toBe(true);
  });

  it('treats an open end date as still running', () => {
    expect(rangesOverlap(range('2021-03', ''), range('2023-01', '2024-06'))).toBe(true);
  });

  it('separates two stints that do not overlap', () => {
    expect(rangesOverlap(range('2015-01', '2017-06'), range('2021-03', ''))).toBe(false);
  });

  it('calls identical strings an overlap even when unparseable', () => {
    expect(rangesOverlap(range('spring', 'later'), range('spring', 'later'))).toBe(true);
  });

  it('declines to guess when a date cannot be read', () => {
    expect(rangesOverlap(range('spring', ''), range('2021-03', ''))).toBe(false);
  });
});

describe('monthsSince', () => {
  const now = new Date('2026-08-02T00:00:00Z');

  it.each([['2025-11', 9], ['11/2025', 9], ['November 2025', 9]])('%s -> %i months', (raw, n) => {
    expect(monthsSince(raw, now)).toBe(n);
  });

  it('is null when there is no date to measure from', () => {
    expect(monthsSince('Present', now)).toBeNull();
  });
});
