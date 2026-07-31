/**
 * Word-level diff for the review UI.
 *
 * A plain longest-common-subsequence over whitespace-delimited words. Reviewing
 * a rephrasing is much faster when the two or three words that actually changed
 * are highlighted, rather than two paragraphs shown side by side.
 */

export type DiffOp = { type: 'same' | 'add' | 'remove'; text: string };

export function diffWords(before: string, after: string): DiffOp[] {
  const a = before.split(/(\s+)/).filter((s) => s !== '');
  const b = after.split(/(\s+)/).filter((s) => s !== '');

  // Standard LCS table. Resume bullets are short, so the O(n·m) cost is
  // irrelevant and the clarity is worth more than an optimised diff.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  const push = (type: DiffOp['type'], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push('same', a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push('remove', a[i]!);
      i++;
    } else {
      push('add', b[j]!);
      j++;
    }
  }
  while (i < a.length) push('remove', a[i++]!);
  while (j < b.length) push('add', b[j++]!);

  return ops;
}
