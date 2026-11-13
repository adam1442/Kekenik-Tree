import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const root = path.dirname(fileURLToPath(import.meta.url));

// The production build is one self-contained `dist/index.html` (JS, CSS and the bundled Inter font are inlined),
// so it runs from any sub-path (GitHub Pages project site), from a plain static host, or straight from disk.
// `base` is the GitHub Pages sub-path; vite-plugin-singlefile rewrites it to './' for the emitted HTML, so the
// favicon and manifest links stay relative and no absolute `/assets/...` URL exists in the output.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.VITE_BASE ?? '/Kekenik-Tree/') : '/',
  plugins: [viteSingleFile()],
  resolve: {
    alias: { '@': path.resolve(root, 'src') },
  },
  build: {
    sourcemap: false,
    target: 'es2020',
  },
}));
