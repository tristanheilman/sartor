/**
 * Parsing shared between tests that hold a markdown file against the CLI:
 * the `sartor …` invocations it tells an agent to run, and a skill's YAML
 * frontmatter.
 */

export interface CommandMention {
  /** The command it names — the longest run of leading words that is a real
   * command, or those words as written when none is. */
  said: string;
  known: boolean;
  /** 1-indexed line in the source markdown. */
  line: number;
  /** Whether the mention was inside a fenced code block, rather than an inline `code span`. */
  fenced: boolean;
  /** Every `--flag` on the same line (or, inside a fence, the same line minus a trailing `# comment`). */
  flags: string[];
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

/**
 * The runnable text on each line: an inline `code span`, or — inside a
 * fenced code block — the line itself with a trailing `# comment` dropped.
 * Prose outside of code is never returned, so a sentence that happens to
 * contain the word "sartor" is not mistaken for an invocation.
 */
function codeText(md: string): Array<{ text: string; line: number; fenced: boolean }> {
  const out: Array<{ text: string; line: number; fenced: boolean }> = [];
  const lines = md.split('\n');
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push({ text: raw.split('#')[0]!, line: i + 1, fenced: true });
    } else {
      for (const m of raw.matchAll(/`([^`]+)`/g)) out.push({ text: m[1]!, line: i + 1, fenced: false });
    }
  }
  return out;
}

/**
 * Every `sartor …` invocation in a markdown file — inline or in a code block
 * — as the command it names, plus every `--flag` on its line.
 */
export function commandsIn(md: string, known: Set<string>): CommandMention[] {
  const out: CommandMention[] = [];
  for (const { text, line, fenced } of codeText(md)) {
    for (const m of text.matchAll(/(?:^|[\s(])sartor((?: [a-z]+){1,2})/g)) {
      const words = m[1]!.trim().split(' ');
      if (words[0] === 'version' || words[0] === 'help') continue;
      let said = words.join(' ');
      let isKnown = false;
      for (const n of [2, 1]) {
        const name = words.slice(0, n).join(' ');
        if (known.has(name)) {
          said = name;
          isKnown = true;
          break;
        }
      }
      const flags = [...text.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)/g)].map((f) => f[1]!);
      out.push({ said, known: isKnown, line, fenced, flags });
    }
  }
  return out;
}
