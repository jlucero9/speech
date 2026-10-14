// Arranca Speech en desarrollo.
//   npm start            compila, prepara los bundles firmados y abre la app
//   npm run start:debug  igual, con los inspectores de main (9339) y de las
//                        ventanas (9338) abiertos en 127.0.0.1, y SPEECH_DEBUG=1
//
// El registro se muestra aquí; Ctrl+C cierra la app.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const raiz = join(import.meta.dirname, '..');
const debug = process.argv.includes('--debug');
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

paso('node', ['scripts/build.mjs']);
paso(join(raiz, 'scripts', 'helper.sh'));
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
paso('open', ['-a', APP, '--stdout', LOG, '--stderr', LOG, '--args', ...args], env);

if (!(await esperar(() => pidEnMarcha() !== null, 10000))) {
  console.error('La app no arrancó. Registro:', LOG);
  process.exit(1);
}
const pid = pidEnMarcha();
console.log(`\nSpeech en marcha (pid ${pid}). Icono en la barra de menús. Ctrl+C para cerrarla.\n`);

const tail = spawn('tail', ['-n', '+1', '-F', LOG], { stdio: ['ignore', 'inherit', 'ignore'] });
const salir = (code) => {
  tail.kill();
  process.exit(code);
};
process.on('SIGINT', () => {
  const p = pidEnMarcha();
  if (p) process.kill(p, 'SIGTERM');
  salir(0);
});
setInterval(() => {
  if (!pidEnMarcha()) {
    console.log('\nSpeech se ha cerrado.');
    salir(0);
  }
}, 1000);
