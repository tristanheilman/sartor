import { defineConfig } from 'tsup';

/**
 * Library build.
 *
 * This is separate from `vite build`, which produces the deployable web app.
 * Two different artifacts from one source tree: `dist-app/` is the site,
 * `dist/` is the npm package.
 *
 * esbuild resolves the `@/*` tsconfig paths while bundling, so nothing
 * unresolvable ends up in the published output — that was the single biggest
 * blocker to publishing this at all.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    render: 'src/render.ts',
    parse: 'src/parse.ts',
  },
  format: ['esm'],
  // Declarations come from `tsc --emitDeclarationOnly` instead: tsup's bundled
  // rollup-plugin-dts pins TypeScript 5.7 and crashes against the TS 7 this
  // project uses. See the `build:types` script.
  dts: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  splitting: true,
  outDir: 'dist',

  // Every peer stays external. Bundling `@react-pdf/renderer` or the provider
  // SDKs into our output would bloat the package and, worse, risk a consumer
  // ending up with two copies of React.
  external: [
    'react',
    'react-dom',
    '@react-pdf/renderer',
    'docx',
    'pdfjs-dist',
    'mammoth',
    '@anthropic-ai/sdk',
    'openai',
    '@google/genai',
  ],

  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
