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
  /** Whether the mention was inside a fenced code block, rather than inline. */
  fenced: boolean;
  /** Every `--flag` that belongs to this mention: up to the next `sartor`
   * mention on the same text, or its end, never spilling into a sibling
   * command on the same line. */
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

/** Whether line `i` (0-indexed) sits inside a fenced code block. */
function fenceFlags(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fenced = false;
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      out.push(false);
      continue;
    }
    out.push(fenced);
  }
  return out;
}

/** A command name a `sartor` prefix is followed by — not a flag, version or help. */
const RAW_COMMAND = /(?:^|[`\s(])sartor((?: [a-z]+){1,2})/g;
const CODE_COMMAND = /(?:^|[\s(])sartor((?: [a-z]+){1,2})/g;

/** Every `sartor …` command on one snippet of text, with the `--flag`s that
 * belong to each — from where it starts to where the next one (if any)
 * starts, so two commands sharing a line never see each other's flags. */
function mentionsIn(text: string, re: RegExp, known: Set<string>, line: number, fenced: boolean): CommandMention[] {
  const matches = [...text.matchAll(re)];
  const out: CommandMention[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
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
    const end = matches[i + 1]?.index ?? text.length;
    const scope = text.slice(m.index, end);
    const flags = [...scope.matchAll(/--([a-zA-Z][a-zA-Z0-9-]*)/g)].map((f) => f[1]!);
    out.push({ said, known: isKnown, line, fenced, flags });
  }
  return out;
}

/**
 * Every `sartor …` invocation in a markdown file, as the command it names,
 * plus every `--flag` that belongs to it.
 *
 * By default this looks at the raw text, inline or in a code block, exactly
 * as it always has. Pass `codeOnly` to look only inside a `code span` or a
 * fenced block (minus a trailing `# comment`) — needed for a file, like the
 * README, that also talks *about* `sartor` in plain prose: a sentence like
 * "sartor never touches it" matches the same pattern without being an
 * invocation, which skill files and the CLI reference never happen to do.
 */
export function commandsIn(md: string, known: Set<string>, opts: { codeOnly?: boolean } = {}): CommandMention[] {
  const lines = md.split('\n');
  const out: CommandMention[] = [];

  if (!opts.codeOnly) {
    const fencedByLine = fenceFlags(lines);
    for (let i = 0; i < lines.length; i++) out.push(...mentionsIn(lines[i]!, RAW_COMMAND, known, i + 1, fencedByLine[i]!));
    return out;
  }

  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(...mentionsIn(raw.split('#')[0]!, CODE_COMMAND, known, i + 1, true));
    } else {
      for (const span of raw.matchAll(/`([^`]+)`/g)) out.push(...mentionsIn(span[1]!, CODE_COMMAND, known, i + 1, false));
    }
  }
  return out;
}
