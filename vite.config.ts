import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// `BASE_PATH` lets the same build target GitHub Pages (`/sartor/`) or a root
// deploy. The Pages workflow sets it; local dev and Cloudflare Pages use `/`.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [react(), tailwind()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    // No manual chunking: pdfjs, the PDF/DOCX renderers, and all three provider
    // SDKs are reached through dynamic `import()`, so they are already split out
    // and none of them is loaded until the user does something that needs them.
  },
});
