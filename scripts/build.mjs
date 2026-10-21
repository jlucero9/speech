// Compila main y preload con esbuild, la interfaz con Vite y el módulo
// nativo de la barra con clang, en out/.
// Uso: npm run build
import { build as esbuild } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
await esbuild({ ...comun, entryPoints: [join(raiz, 'src/preload/recorder.ts')], outfile: join(out, 'preload/recorder.js') });
await esbuild({ ...comun, entryPoints: [join(raiz, 'src/preload/bar.ts')], outfile: join(out, 'preload/bar.js') });
// Node-API es estable entre versiones: basta con las cabeceras del Node que
// ejecuta este script; los símbolos los pone Electron al cargarlo.
const nativo = join(raiz, 'native/panel.mm');
const modulo = join(out, 'native/panel.node');
if (!existsSync(modulo) || statSync(modulo).mtimeMs < statSync(nativo).mtimeMs) {
  const cabeceras = join(dirname(process.execPath), '..', 'include', 'node');
  if (!existsSync(join(cabeceras, 'node_api.h'))) throw new Error(`No están las cabeceras de Node en ${cabeceras}`);
  await mkdir(dirname(modulo), { recursive: true });
  execFileSync('xcrun', [
    'clang++', '-std=c++17', '-x', 'objective-c++', '-fobjc-arc', '-O2', '-arch', 'arm64',
    '-mmacosx-version-min=13.0', '-bundle', '-undefined', 'dynamic_lookup',
    '-I', cabeceras, '-framework', 'AppKit', '-o', modulo, nativo,
  ], { stdio: 'inherit' });
}
await vite({ configFile: join(raiz, 'vite.config.mts'), logLevel: 'warn' });
console.log('Compilado en out/');
