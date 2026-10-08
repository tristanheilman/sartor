import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * How the CLI talks to whatever runs it.
 *
 * Written for an agent first and a person second, because an agent is the
 * caller that cannot ask what a message meant:
 *
 *   - Every command answers with one JSON envelope on stdout — the same shape
 *     everywhere — when stdout is not a terminal, or when `--json` is passed.
 *     A person at a terminal gets text instead.
 *   - Progress and diagnostics go to stderr, so stdout is always parseable.
 *   - A failure is an envelope too, with a stable `code`, a sentence saying
 *     what went wrong, and a `hint` saying what to do about it. The exit code
 *     says which kind of failure it was without parsing anything.
 *   - Nothing ever prompts. Every input is a flag, an argument, or stdin.
 *   - Successful commands suggest the commands that usually come next, so an
 *     agent can follow the workflow without having memorised it.
 */

/** Exit codes. Stable: an agent may branch on them. */
export const EXIT = {
  ok: 0,
  /** A bug in the CLI. The error says so. */
  internal: 1,
  /** Unknown command, unknown flag, missing argument. */
  usage: 2,
  /** A file is missing or unreadable, or its contents do not fit the schema. */
  input: 3,
  /** The model provider failed: no key, bad key, rate limit, network. */
  provider: 4,
  /** The command ran but refused to finish: an unreviewed fabrication, a page target missed. */
  blocked: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    /** Stable, snake_case. Branch on this, not on the message. */
    readonly code: string,
    message: string,
    /** What to do about it, as a sentence or a command to run. */
    readonly hint: string,
    readonly exit: ExitCode = EXIT.input,
    /** Anything structured the caller needs to act on the failure. */
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface Io {
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
  stdin: AsyncIterable<Buffer | string> & { isTTY?: boolean };
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface Envelope {
  ok: boolean;
  command: string;
  data?: unknown;
  warnings?: string[];
  /** Commands that usually come next, ready to run. */
  next?: string[];
  error?: { code: string; message: string; hint: string; details?: unknown };
}

export interface Result {
  data: unknown;
  /** The same result for a person reading a terminal. */
  text: string;
  warnings?: string[];
  next?: string[];
  /** Exit with this code even though the command produced a result. */
  exit?: ExitCode;
}

/** JSON unless a person is plainly watching, or the caller asked. */
export function wantsJson(io: Io, flags: { json?: boolean; human?: boolean }): boolean {
  if (flags.json) return true;
  if (flags.human) return false;
  return !io.stdout.isTTY;
}

export function emit(io: Io, json: boolean, command: string, result: Result): void {
  if (json) {
    const envelope: Envelope = { ok: (result.exit ?? EXIT.ok) === EXIT.ok, command, data: result.data };
    if (result.warnings?.length) envelope.warnings = result.warnings;
    if (result.next?.length) envelope.next = result.next;
    io.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  io.stdout.write(`${result.text.trimEnd()}\n`);
  for (const w of result.warnings ?? []) io.stderr.write(`warning: ${w}\n`);
  if (result.next?.length) io.stdout.write(`\nNext:\n${result.next.map((n) => `  ${n}`).join('\n')}\n`);
}

export function emitError(io: Io, json: boolean, command: string, err: CliError): void {
  if (json) {
    const envelope: Envelope = {
      ok: false,
      command,
      error: { code: err.code, message: err.message, hint: err.hint, ...(err.details ? { details: err.details } : {}) },
    };
    io.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  }
  // A person always gets it on stderr; an agent gets it there too, which costs
  // nothing and helps whoever reads its logs.
  io.stderr.write(`error: ${err.message}\n  ${err.hint}\n`);
}

/** A path relative to where the command was run. */
export function at(io: Io, path: string): string {
  return resolve(io.cwd, path);
}

/** Reads a file, or stdin when the path is `-`. */
export async function readText(io: Io, path: string, what: string): Promise<string> {
  if (path === '-') {
    if (io.stdin.isTTY) {
      throw new CliError('stdin_is_terminal', `Expected ${what} on stdin, but stdin is a terminal.`, `Pipe it in, or pass a file path instead of "-".`, EXIT.usage);
    }
    const chunks: string[] = [];
    for await (const chunk of io.stdin) chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return chunks.join('');
  }
  try {
    return await readFile(at(io, path), 'utf8');
  } catch {
    throw new CliError('file_not_found', `Could not read ${what} at ${path}.`, `Check the path; it is resolved from ${io.cwd}.`);
  }
}

export async function readBytes(io: Io, path: string, what: string): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const buf = await readFile(at(io, path));
    return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  } catch {
    throw new CliError('file_not_found', `Could not read ${what} at ${path}.`, `Check the path; it is resolved from ${io.cwd}.`);
  }
}

export async function readJson(io: Io, path: string, what: string): Promise<unknown> {
  const text = await readText(io, path, what);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(
      'invalid_json',
      `${what} at ${path} is not valid JSON (${e instanceof Error ? e.message : String(e)}).`,
      'Write the file as a single JSON value, with nothing before or after it.',
    );
  }
}

/** Writes a file, creating its directory; `-` writes to stdout instead. */
export async function writeOut(io: Io, path: string, body: string | Uint8Array): Promise<string> {
  if (path === '-') {
    io.stdout.write(typeof body === 'string' ? body : Buffer.from(body).toString('utf8'));
    return '-';
  }
  const full = at(io, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body);
  return full;
}

/** A zod error as one sentence an agent can act on: where, and what was wrong. */
export function describeIssues(issues: Array<{ path: PropertyKey[]; message: string }>, max = 5): string {
  return issues
    .slice(0, max)
    .map((i) => `${i.path.length ? i.path.map(String).join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}
