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

/** A markdown file's fenced-block lines and inline code spans, trimmed — the only places a `sartor` word is ever an invocation rather than prose using the product's name. */
function codeLines(md: string): string[] {
  const fenced = [...md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.split('\n'));
  const inline = [...md.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
  return [...fenced, ...inline].map((s) => s.trim());
}

/**
 * Every `sartor …` invocation in a markdown file — inline or in a code block —
 * as the command it names: the longest run of its leading words that is a
 * real command, or those words as written when none is. Only a code line
 * that starts with `sartor` counts, so a sentence that merely mentions the
 * product ("sartor never touches it") or a trailing shell comment ("# sartor,
 * from the sartor marketplace") is not read as a command.
 */
export function commandsIn(md: string): Array<{ said: string; known: boolean }> {
  return codeLines(md)
    .filter((line) => line.startsWith('sartor'))
    .flatMap((line): Array<{ said: string; known: boolean }> => {
      const m = /^sartor((?: [a-z]+){1,2})/.exec(line);
      if (!m) return [];
      const words = m[1]!.trim().split(' ');
      if (words[0] === 'version' || words[0] === 'help') return [];
      const name = commandFor(words);
      return [name ? { said: name, known: true } : { said: words.join(' '), known: false }];
    });
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
