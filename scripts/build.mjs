// Compila main y preload con esbuild y la interfaz con Vite, en out/.
// Uso: npm run build
import { build as esbuild } from 'esbuild';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build as vite } from 'vite';

const raiz = join(import.meta.dirname, '..');
const out = join(raiz, 'out');
await rm(join(out, 'main'), { recursive: true, force: true });
await rm(join(out, 'preload'), { recursive: true, force: true });

const comun = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'warning',
};
await esbuild({ ...comun, entryPoints: [join(raiz, 'src/main/index.ts')], outfile: join(out, 'main/index.js') });
await esbuild({ ...comun, entryPoints: [join(raiz, 'src/preload/index.ts')], outfile: join(out, 'preload/index.js') });
await vite({ configFile: join(raiz, 'vite.config.mts'), logLevel: 'warn' });
console.log('Compilado en out/');
