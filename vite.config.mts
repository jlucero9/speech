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
    rollupOptions: {
      input: {
        hub: resolve(import.meta.dirname, 'src/renderer/index.html'),
        // Barra flotante: siempre viva, en su propia ventana.
        bar: resolve(import.meta.dirname, 'src/renderer/bar/index.html'),
        // Ventana oculta de grabación: sin React.
        recorder: resolve(import.meta.dirname, 'src/renderer/recorder/index.html'),
      },
    },
  },
});
