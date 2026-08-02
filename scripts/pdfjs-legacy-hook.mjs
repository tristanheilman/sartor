/**
 * Resolves `pdfjs-dist` to its `legacy` build for anything running under Node.
 *
 * The library imports `pdfjs-dist` by bare specifier, which is correct: it is a
 * browser library and has no business branching on its runtime. Node then gets
 * the modern build, which needs `Promise.withResolvers`, `Promise.try` and
 * `Uint8Array.prototype.toHex` — none of which exist before Node 22, and which
 * pdf.js ships an entire `legacy` build to avoid needing.
 *
 * So the adaptation lives in the harness, exactly like the alias in
 * `vitest.config.ts`. Same source at a lower syntax target, so the audit still
 * exercises the real extraction code.
 *
 * Registered by `audit-run.mjs` via `module.register`.
 */

const LEGACY = 'pdfjs-dist/legacy/build/pdf.mjs';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'pdfjs-dist') return nextResolve(LEGACY, context);
  return nextResolve(specifier, context);
}
