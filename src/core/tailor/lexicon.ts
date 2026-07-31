/**
 * Tokenisation and lexicon building for the fabrication guard.
 *
 * The whole guard rests on one comparison: does every proper noun and every
 * number in the generated text trace back to something the user actually wrote
 * in their master profile? Getting that comparison right is mostly a
 * tokenisation problem, because resumes are full of tokens that naive splitting
 * destroys — `Node.js`, `C++`, `CI/CD`, `.NET`, `40%`, `$1.2M`, `3x`, `Google's`.
 */

/** Characters that are part of a token rather than delimiters around it.
 * The optional leading dot keeps `.NET` intact. */
const TOKEN_RE = /\.?[A-Za-z0-9][A-Za-z0-9'’.+#/&-]*/g;

/** Sentence-ending punctuation, allowing for trailing quotes/brackets. */
const ENDS_SENTENCE = /[.!?][)"'’\]]*$/;
const GAP_BOUNDARY = /[.!?\n\r•·|;]/;

/** Trailing punctuation that is grammar, not part of the token. */
function trimEdges(raw: string): string {
  return raw.replace(/^[^A-Za-z0-9.+#]+/, '').replace(/[.'’,;:!?)\]}-]+$/, '');
}

export interface Token {
  /** Text exactly as it appeared. */
  raw: string;
  /** Lowercased, edge-trimmed, possessive-stripped. */
  norm: string;
  /** Character offset of `raw` in the source string. */
  index: number;
  /** True if this is the first token of a sentence (or of the whole string). */
  sentenceStart: boolean;
}

/** Strips `'s` / `’s` so `Google's` matches `Google`. */
function stripPossessive(s: string): string {
  return s.replace(/['’]s$/i, '').replace(/['’]$/, '');
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let sentenceStart = true;
  let prevRaw = '';
  let lastEnd = 0;

  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const index = m.index;

    if (lastEnd > 0) {
      // A boundary can live either inside the previous match (`work.` swallows
      // its own full stop, because `.` is a valid intra-token character) or in
      // the gap between matches (` — `, a newline, a bullet glyph).
      const gap = text.slice(lastEnd, index);
      sentenceStart = ENDS_SENTENCE.test(prevRaw) || GAP_BOUNDARY.test(gap);
    }

    const trimmed = trimEdges(raw);
    const norm = stripPossessive(trimmed).toLowerCase();
    if (norm) tokens.push({ raw: trimmed, norm, index, sentenceStart });

    prevRaw = raw;
    lastEnd = index + raw.length;
  }
  return tokens;
}

/**
 * All the equivalent forms of a token that should count as "the same fact".
 * `40%`, `40`, and `$40` are the same number; `APIs` and `API` are the same noun.
 */
export function equivalentForms(norm: string): string[] {
  const forms = new Set<string>([norm]);

  // Strip currency/percent/multiplier decoration around numbers.
  const bare = norm.replace(/^[$€£]/, '').replace(/[%x]$/, '');
  if (bare) forms.add(bare);

  // Thousands separators: 1,200 -> 1200
  if (bare.includes(',')) forms.add(bare.replace(/,/g, ''));

  // Magnitude suffixes: 1.2m -> 1.2
  const mag = bare.replace(/(k|m|b|bn|mm)$/i, '');
  if (mag && mag !== bare) forms.add(mag);

  // Compound tokens ground their parts. `2024-11` grounds the year `2024`;
  // `CI/CD` grounds `CI`. The user wrote the compound, so the components are
  // theirs too — this only ever widens what counts as verified, never narrows.
  for (const part of norm.split(/[-/]/)) {
    if (part.length >= 2) forms.add(part);
  }

  // Simple plural/singular folding for acronyms and nouns: APIs -> api
  if (norm.length > 2) {
    if (norm.endsWith('es')) forms.add(norm.slice(0, -2));
    if (norm.endsWith('s')) forms.add(norm.slice(0, -1));
  }
  forms.add(`${norm}s`);

  return [...forms].filter(Boolean);
}

/** Recursively collects every string value in a JSON-like structure. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStrings(v, out);
  }
  return out;
}

/**
 * The set of every token form present in the source. A token in generated text
 * is "grounded" if any of its equivalent forms is in this set.
 */
export function buildLexicon(source: unknown): Set<string> {
  const lex = new Set<string>();
  for (const s of collectStrings(source)) {
    for (const t of tokenize(s)) {
      for (const form of equivalentForms(t.norm)) lex.add(form);
    }
  }
  return lex;
}

export function isGrounded(norm: string, lexicon: Set<string>): boolean {
  return equivalentForms(norm).some((f) => lexicon.has(f));
}
