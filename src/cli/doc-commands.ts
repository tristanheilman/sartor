import { COMMANDS } from './main';

/**
 * Shared by `skills.test.ts` and `docs.test.ts`: both hold a markdown file to
 * the CLI it documents, so both need to read a `sartor …` invocation out of
 * prose and a skill's YAML frontmatter.
 */

const known = new Set(COMMANDS.map((c) => c.name));

/** The command `words` (1 or 2, after `sartor`) name — the longest leading run that is a real command — or `undefined` when none is. */
export function commandFor(words: string[]): string | undefined {
  for (const n of [2, 1]) {
    const name = words.slice(0, n).join(' ');
    if (known.has(name)) return name;
  }
  return undefined;
}

/** A `sartor …` invocation named: the longest run of its leading words that is a real command, or those words as written when none is. */
function mentionsIn(text: string, line: number): Array<{ said: string; known: boolean; line: number }> {
  return [...text.matchAll(/(?:^|[\s(])sartor((?: [a-z]+){1,2})/g)].flatMap((m): Array<{ said: string; known: boolean; line: number }> => {
    const words = m[1]!.trim().split(' ');
    if (words[0] === 'version' || words[0] === 'help') return [];
    const name = commandFor(words);
    return [{ said: name ?? words.join(' '), known: !!name, line }];
  });
}

/**
 * Every `sartor …` invocation in a markdown file, with the 1-based line it
 * is on — inside a fenced code block, or an inline code span — as the
 * command it names. Prose that merely mentions "sartor" outside of code
 * ("sartor never touches it") is never read as an invocation. Inside a
 * fenced block, a trailing shell comment is stripped first, so a line like
 * "claude plugin list    # sartor, from the sartor marketplace" — a comment
 * that mentions the product, not a `sartor` command — contributes nothing.
 */
export function commandsIn(md: string): Array<{ said: string; known: boolean; line: number }> {
  const out: Array<{ said: string; known: boolean; line: number }> = [];
  let inFence = false;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lineNumber = i + 1;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(...mentionsIn(raw.replace(/\s+#.*$/, ''), lineNumber));
      continue;
    }
    for (const span of raw.matchAll(/`([^`\n]+)`/g)) out.push(...mentionsIn(span[1]!, lineNumber));
  }
  return out;
}

export function frontmatter(md: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.replace(/^"|"$/g, '');
  }
  return out;
}
