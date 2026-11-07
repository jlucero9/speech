// Arranca Speech en desarrollo.
//   npm start            compila, prepara los bundles firmados y abre la app
//   npm run start:debug  igual, con los inspectores de main (9339) y de las
//                        ventanas (9338) abiertos en 127.0.0.1, y SPEECH_DEBUG=1
//
// El registro se muestra aquí; Ctrl+C cierra la app. Este proceso termina
// cuando se cierra la app que abrió (también si otro arranque la reinicia).
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..');
const debug = process.argv.includes('--debug');
// Sin pasar la app al frente: para reiniciarla sin interrumpir lo que se esté haciendo.
const fondo = process.argv.includes('--background');
const APP = join(homedir(), 'Library', 'Developer', 'Speech', 'dev', 'Speech.app');
const EJECUTABLE = join(APP, 'Contents', 'MacOS', 'Electron');
// Copia del código compilado que abre la app, fuera del Escritorio (ver abajo).
const CODIGO = join(homedir(), 'Library', 'Developer', 'Speech', 'app');
// Salida de la app. Fuera del Escritorio, como la copia del código: la app
// abierta con `open` no puede escribir allí y `open` fallaría (error -10810).
const LOG = join(homedir(), 'Library', 'Developer', 'Speech', 'dev.log');

// `open` transmite el entorno de la terminal a la app. Si la terminal vive en
// una app Electron (T3 Code, VS Code…), ELECTRON_RUN_AS_NODE=1 haría que
// Electron arrancase como Node. Se quitan esas variables.
const entorno = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_') && k !== 'NODE_OPTIONS'),
);

function paso(cmd, args = [], env = entorno) {
  const r = spawnSync(cmd, args, { cwd: raiz, stdio: 'inherit', env });
  if (r.status !== 0) {
    console.error(`\nFalló: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

function pidEnMarcha() {
  try {
    const out = execFileSync('pgrep', ['-f', `^${EJECUTABLE}`], { encoding: 'utf8' }).trim();
    return out ? Number(out.split('\n')[0]) : null;
  } catch {
    return null;
  }
}

async function esperar(cond, ms) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/** Procesos cuya línea de órdenes empieza así, salvo este. */
function procesos(patron) {
  try {
    return execFileSync('pgrep', ['-f', patron], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .map(Number)
      .filter((p) => p && p !== process.pid);
  } catch {
    return [];
  }
}

// Restos de arranques anteriores: otros dev.mjs que siguen mostrando el
// registro y, de versiones anteriores de este script, los `tail` que lo
// seguían y quedaban vivos si su dev.mjs moría sin cerrarlos.
for (const p of [...procesos('node scripts/dev\\.mjs'), ...procesos(`^tail -n \\+1 -F ${LOG}$`)]) {
  try {
    process.kill(p, 'SIGTERM');
  } catch {}
}

paso('node', ['scripts/build.mjs']);
paso(join(raiz, 'scripts', 'helper.sh'));
paso(join(raiz, 'scripts', 'transcriber.sh'));
paso(join(raiz, 'scripts', 'electron-dev.sh'));

// Una instancia anterior se quedaría con el bloqueo de instancia única.
const anterior = pidEnMarcha();
if (anterior) {
  console.log(`Cerrando la instancia anterior (pid ${anterior})…`);
  process.kill(anterior, 'SIGTERM');
  if (!(await esperar(() => !pidEnMarcha(), 5000))) {
    process.kill(anterior, 'SIGKILL');
    await esperar(() => !pidEnMarcha(), 2000);
  }
}

// La app se abre con `open` para que macOS la trate como responsable de sí
// misma: el permiso de micrófono queda ligado a local.speech.dev y no a la
// terminal. Abierta así, no puede leer el código en ~/Desktop sin permiso de
// la carpeta Escritorio (se quedaba parada sin escribir nada), así que se
// abre una copia de out/, package.json y resources/ (todo lo que usa en marcha:
// main y la interfaz van empaquetados, sin node_modules).
rmSync(CODIGO, { recursive: true, force: true });
mkdirSync(CODIGO, { recursive: true });
for (const f of ['out', 'package.json', 'resources']) {
  cpSync(join(raiz, f), join(CODIGO, f), { recursive: true });
}

if (existsSync(LOG)) rmSync(LOG);
writeFileSync(LOG, '');
const args = [CODIGO];
if (debug) args.push('--inspect=127.0.0.1:9339', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9338');
const env = debug ? { ...entorno, SPEECH_DEBUG: '1' } : entorno;
// Justo después de cerrar la instancia anterior, LaunchServices aún puede
// darla por viva y `open` falla con -600: se reintenta unas veces.
for (let intento = 1; ; intento++) {
  const r = spawnSync('open', [...(fondo ? ['-g'] : []), '-a', APP, '--stdout', LOG, '--stderr', LOG, '--args', ...args], { cwd: raiz, stdio: 'inherit', env });
  if (r.status === 0) break;
  if (intento === 5) {
    console.error('\nFalló: open');
    process.exit(r.status ?? 1);
  }
  await new Promise((res) => setTimeout(res, 1000));
}

if (!(await esperar(() => pidEnMarcha() !== null, 10000))) {
  console.error('La app no arrancó. Registro:', LOG);
  process.exit(1);
}
const pid = pidEnMarcha();
console.log(`\nSpeech en marcha (pid ${pid}). Icono en la barra de menús. Ctrl+C para cerrarla.\n`);

// El registro se sigue desde aquí, sin otro proceso que pueda quedar huérfano.
let leido = 0;
const mostrar = () => {
  let tam;
  try {
    tam = statSync(LOG).size;
  } catch {
    return;
  }
  if (tam < leido) leido = 0;
  if (tam === leido) return;
  const fd = openSync(LOG, 'r');
  try {
    const buf = Buffer.alloc(tam - leido);
    const n = readSync(fd, buf, 0, buf.length, leido);
    leido += n;
    process.stdout.write(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
};
const vivo = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
process.on('SIGINT', () => {
  if (vivo(pid)) process.kill(pid, 'SIGTERM');
  process.exit(0);
});
// Si otro arranque cierra esta instancia, este proceso también termina.
setInterval(() => {
  mostrar();
  if (!vivo(pid)) {
    mostrar();
    console.log('\nSpeech se ha cerrado.');
    process.exit(0);
  }
}, 250);
