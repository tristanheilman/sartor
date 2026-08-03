import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: {
      // The parse tests run the real pdf.js against real PDFs rather than a
      // mock, which means resolving it to the build that works off a browser:
      // the default build calls `Promise.withResolvers`, absent before Node 22,
      // and our floor is Node 20.19.
      //
      // This is safe for what the tests are checking. The `legacy` build is the
      // same source at a lower syntax target, and `for await` — the construct
      // the Safari regression test exists for — is left untranspiled in both.
      // Verify with: grep -c 'for await' node_modules/pdfjs-dist/*/build/pdf.mjs
      'pdfjs-dist': 'pdfjs-dist/legacy/build/pdf.mjs',

      // Same idea. mammoth ships two builds and swaps `unzip.js` between them
      // via its `browser` field: the Node one reads a path or a Buffer, the
      // browser one reads an ArrayBuffer. `extractDocx` hands it an
      // ArrayBuffer, so testing against the Node build would test a code path
      // no user of this library ever runs.
      mammoth: 'mammoth/mammoth.browser.js',
    },
  },
});
