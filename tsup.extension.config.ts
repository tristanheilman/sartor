import { defineConfig } from 'tsup';

/**
 * Builds the browser extension, separately from the library and app builds in
 * `tsup.config.ts` and `vite.config.ts`. `content.ts` and `background.ts` each
 * become a single self-contained script with no imports left to resolve at
 * runtime, which is what `chrome.scripting.executeScript({ files: [...] })`
 * and a classic-script service worker both need.
 */
export default defineConfig({
  entry: {
    content: 'extension/src/content.ts',
    background: 'extension/src/background.ts',
  },
  format: ['iife'],
  // `background.ts` exports a constant for documentation purposes only;
  // esbuild's `iife` format requires a name to hang any exports off of.
  globalName: 'sartorExtension',
  dts: false,
  sourcemap: false,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'extension/dist',
});
