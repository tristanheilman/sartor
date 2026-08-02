/**
 * Reading the dates people actually put on resumes.
 *
 * There is one of these because there were briefly two. `merge.ts` grew a
 * parser that understood `2021-03`, `gaps.ts` grew a separate one that also
 * understood `05/2022`, and a real resume using the second format slipped
 * through the first: two roles at the same employer failed to match on dates,
 * so instead of correcting the end date the merge added a duplicate employer.
 *
 * A resume date is free text by nature — `2021-03`, `05/2022`, `March 2021`,
 * `2019`, `Present`, or nothing at all — and refusing the awkward ones loses
 * data. Everything that reasons about time reads it through here.
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

/** Words a resume uses to mean "still there". */
const ONGOING = /^\s*(present|current|currently|now|ongoing|to date)\s*$/i;

export function isOngoing(raw: string): boolean {
  return !raw.trim() || ONGOING.test(raw);
}

/**
 * A comparable month index, or null when the text carries no date.
 *
 * Months are zero-based within the year, so the value is only ever compared
 * against another produced here — never displayed.
 */
export function toMonths(raw: string): number | null {
  const s = raw.trim();
  if (!s || ONGOING.test(s)) return null;

  // 2021-03, 2021-3, 2021-03-15
  let m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);
  if (m) return Number(m[1]) * 12 + Math.min(11, Number(m[2]) - 1);

  // 05/2022, 5/2022, 05/15/2022
  m = /^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/.exec(s);
  if (m) return Number(m[2]) * 12 + Math.min(11, Number(m[1]) - 1);

  // March 2021, Mar 2021, Mar. 2021
  m = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[1]!.toLowerCase()];
    if (month !== undefined) return Number(m[2]) * 12 + month;
  }

  // 2021-03 buried in longer text, e.g. "2021-03 – Present"
  m = /^(\d{4})/.exec(s);
  if (m) return Number(m[1]) * 12;

  return null;
}

/** Months between a date and `now`, or null if the date cannot be read. */
export function monthsSince(raw: string, now: Date): number | null {
  const then = toMonths(raw);
  if (then === null) return null;
  return now.getUTCFullYear() * 12 + now.getUTCMonth() - then;
}

/**
 * Do two dated ranges overlap?
 *
 * Answers "yes" only when it can tell. An unparseable date is not evidence of
 * a separate stint, but it is not evidence of the same one either, and callers
 * treat the ambiguity as a weak match rather than guessing.
 */
export function rangesOverlap(
  a: { startDate: string; endDate: string },
  b: { startDate: string; endDate: string },
): boolean {
  // Identical strings overlap by definition, whether or not they parse.
  if (a.startDate === b.startDate && a.endDate === b.endDate) return true;

  const aStart = toMonths(a.startDate);
  const bStart = toMonths(b.startDate);
  if (aStart === null || bStart === null) return false;

  // An ongoing or unreadable end date on a role with a real start means
  // "still there".
  const aEnd = toMonths(a.endDate) ?? Infinity;
  const bEnd = toMonths(b.endDate) ?? Infinity;

  return aStart <= bEnd && bStart <= aEnd;
}
