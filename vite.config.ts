import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

// `BASE_PATH` lets the same build target GitHub Pages (`/sartor/`) or a root
// deploy. The Pages workflow sets it; local dev and Cloudflare Pages use `/`.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react(), tailwind()],
  build: {
    // `dist/` belongs to the npm package (see tsup.config.ts). The deployable
    // site goes somewhere else so the two builds cannot clobber each other.
    outDir: 'dist-app',
    target: 'es2022',
    // No manual chunking: pdfjs, the PDF/DOCX renderers, and all three provider
    // SDKs are reached through dynamic `import()`, so they are already split out
    // and none of them is loaded until the user does something that needs them.
  },
});
