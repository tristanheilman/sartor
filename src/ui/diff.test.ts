import { describe, it, expect } from 'vitest';
import { diffWords } from './diff';

const render = (ops: ReturnType<typeof diffWords>) =>
  ops.map((o) => (o.type === 'same' ? o.text : `${o.type === 'add' ? '+' : '-'}[${o.text}]`)).join('');

describe('diffWords', () => {
  it('reports identical strings as unchanged', () => {
    expect(diffWords('a b c', 'a b c').every((o) => o.type === 'same')).toBe(true);
  });

  it('isolates a single replaced word', () => {
    expect(render(diffWords('Led the migration', 'Directed the migration'))).toBe(
      '-[Led]+[Directed] the migration',
    );
  });

  it('handles pure insertion', () => {
    expect(render(diffWords('cut latency', 'cut p99 latency'))).toContain('+[p99 ]');
  });

  it('handles pure deletion', () => {
    expect(render(diffWords('cut p99 latency', 'cut latency'))).toContain('-[p99 ]');
  });

  it('reconstructs both sides exactly', () => {
    const before = 'Migrated the billing service to PostgreSQL, cutting latency by 40%.';
    const after = 'Moved billing to PostgreSQL and cut latency 40%.';
    const ops = diffWords(before, after);
    expect(ops.filter((o) => o.type !== 'add').map((o) => o.text).join('')).toBe(before);
    expect(ops.filter((o) => o.type !== 'remove').map((o) => o.text).join('')).toBe(after);
  });

  it('handles an empty side', () => {
    expect(diffWords('', 'new text').every((o) => o.type === 'add')).toBe(true);
    expect(diffWords('old text', '').every((o) => o.type === 'remove')).toBe(true);
  });
});
