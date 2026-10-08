#!/usr/bin/env node
import { createRequire, register } from 'node:module';
import { main } from './main';

/**
 * The `sartor` executable: Node setup, then `main`.
 *
 * Everything here is what the browser provides and Node does not. `main`
 * itself takes its streams and environment as arguments, so it is tested
 * in-process without any of this.
 */

// Before anything can import pdf.js.
register('./cli/pdfjs-hook.js', import.meta.url);
// pdf.js does not touch DOMMatrix when extracting text, but checks it exists.
(globalThis as { DOMMatrix?: unknown }).DOMMatrix ??= class DOMMatrix {};

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const code = await main(
  process.argv.slice(2),
  { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin, cwd: process.cwd(), env: process.env },
  version,
);
// Not process.exit(): that can cut off a large JSON envelope still being written to a pipe.
process.exitCode = code;
