/**
 * Resolves `pdfjs-dist` to its `legacy` build when the CLI runs under Node.
 *
 * The library imports `pdfjs-dist` by bare specifier, which is right for a
 * browser library. Under Node that is the modern build, which needs
 * `Promise.withResolvers` and friends — absent before Node 22, and sartor
 * supports 20.19. pdf.js ships a `legacy` build for exactly this. The same
 * redirect the test run and the audit script use.
 */
export async function resolve(
  specifier: string,
  context: unknown,
  nextResolve: (specifier: string, context: unknown) => Promise<unknown>,
): Promise<unknown> {
  if (specifier === 'pdfjs-dist') return nextResolve('pdfjs-dist/legacy/build/pdf.mjs', context);
  return nextResolve(specifier, context);
}
