import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Solo la interfaz. main y preload los compila esbuild (scripts/build.mjs).
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'out/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    // Las fuentes se sirven como ficheros, no incrustadas en el CSS.
    assetsInlineLimit: 0,
  },
});
