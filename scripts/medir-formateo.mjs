// Mide el formateo con los mismos módulos que usa la app, sin abrirla.
//
//   npm run medir:formateo -- --cases casos.json --providers ollama:qwen3:1.7b,groq:openai/gpt-oss-20b
//                             [--reps 3] [--cold] [--gap ms] [--out resultados.json]
//
// casos.json: [{ "id": "es1", "language": "es", "text": "…", "appName"?: "…",
//               "surroundings"?: { "before": "…", "after": "…", "selected": "" } }]
//
// Para cada proveedor:
//   frío (--cold, solo Ollama): se suelta el modelo y se mide el primer caso,
//        carga incluida;
//   cargado: mediana de --reps formateos de cada caso con el modelo listo;
// y, para Ollama, la memoria del modelo según el propio Ollama (`/api/ps`) y
// la del proceso que lo ejecuta (phys_footprint, con `footprint`).
// La app guarda las claves en el llavero, ligadas a su firma; aquí se pasan con
// --key-groq y --key-gemini: la ruta de un fichero que solo contiene la clave.
// --gap deja una pausa entre peticiones para no chocar con los límites por
// minuto de los niveles gratuitos (no cuenta en la latencia).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const casesFile = arg('cases', '');
const providers = String(arg('providers', '')).split(',').filter(Boolean);
const reps = Number(arg('reps', 3));
const cold = arg('cold', false) === true;
const outFile = arg('out', '');
const gap = Number(arg('gap', 0));
if (!casesFile || !providers.length) {
  console.error('Uso: npm run medir:formateo -- --cases casos.json --providers ollama:modelo,groq:modelo,gemini:modelo');
  process.exit(1);
}
const cases = JSON.parse(readFileSync(resolve(casesFile), 'utf8'));

// Los módulos de la app, compilados al vuelo (no dependen de Electron).
const raiz = join(import.meta.dirname, '..');
const bundle = await build({
  stdin: {
    contents: `export * from './ollama'; export * from './cloud'; export * from './formatter';`,
    resolveDir: join(raiz, 'src/main/formatting'),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'warning',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

function makeFormatter(spec) {
  const [provider, ...rest] = spec.split(':');
  const model = rest.join(':');
  if (provider === 'ollama') return new mod.OllamaFormatter({ model, keepAlive: '10m' });
  const readKey = async (p) => readFileSync(resolve(String(arg(`key-${p}`, ''))), 'utf8').trim();
  if (provider === 'groq') return new mod.GroqFormatter(model, readKey);
  if (provider === 'gemini') return new mod.GeminiFormatter(model, readKey);
  throw new Error(`Proveedor desconocido: ${provider}`);
}

async function once(f, c) {
  if (gap && f.provider !== 'ollama') await new Promise((r) => setTimeout(r, gap));
  const t0 = performance.now();
  try {
    const r = await f.format({
      id: c.id,
      text: c.text,
      language: c.language,
      appName: c.appName ?? null,
      surroundings: c.surroundings ?? null,
      vocabulary: c.vocabulary ?? [],
      signal: AbortSignal.timeout(30_000),
    });
    return { ms: r.ms, text: r.text, error: null, detail: r.detail ?? null };
  } catch (err) {
    return { ms: Math.round(performance.now() - t0), text: null, error: `${err.code ?? 'error'}: ${err.message}` };
  }
}

async function ollamaMemory(model) {
  try {
    const ps = await (await fetch(`${mod.OLLAMA_URL}/api/ps`)).json();
    const m = ps.models?.find((x) => x.name === model || x.model === model);
    // Los procesos que cargan los modelos son hijos de «ollama serve».
    let footprint = null;
    let rss = null;
    const serve = execFileSync('pgrep', ['-f', 'ollama serve'], { encoding: 'utf8' }).trim().split('\n')[0];
    const pids = execFileSync('pgrep', ['-P', serve], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      const out = execFileSync('footprint', ['-p', pid], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const fp = /Footprint:\s*([\d.]+)\s*([KMG])B/.exec(out);
      if (fp) footprint = (footprint ?? 0) + Number(fp[1]) * { K: 1 / 1024, M: 1, G: 1024 }[fp[2]];
      const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim());
      rss = (rss ?? 0) + kb / 1024;
    }
    return {
      ollamaMB: m ? Math.round(m.size / 2 ** 20) : null,
      footprintMB: footprint == null ? null : Math.round(footprint),
      rssMB: rss == null ? null : Math.round(rss),
    };
  } catch {
    return { ollamaMB: null, footprintMB: null, rssMB: null };
  }
}

async function unloadAll() {
  try {
    const ps = await (await fetch(`${mod.OLLAMA_URL}/api/ps`)).json();
    for (const m of ps.models ?? []) {
      await fetch(`${mod.OLLAMA_URL}/api/chat`, {
        method: 'POST',
        body: JSON.stringify({ model: m.name, messages: [], keep_alive: 0 }),
      });
    }
    // Hasta que el proceso del modelo termina.
    for (let i = 0; i < 50; i++) {
      const left = await (await fetch(`${mod.OLLAMA_URL}/api/ps`)).json();
      if (!left.models?.length) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // Ollama parado: el formateo fallará y se anotará.
  }
}

async function runnerOf(model) {
  try {
    const out = execFileSync('ollama', ['ps'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.startsWith(model + ' '));
    return line?.trim().split(/\s{2,}/)[5] ?? null;
  } catch {
    return null;
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

const results = [];
for (const spec of providers) {
  const f = makeFormatter(spec);
  const entry = { spec, cold: null, memory: null, cases: [] };
  console.log(`\n== ${spec}`);
  // Un solo modelo cargado a la vez: la memoria medida es la suya.
  if (f.provider === 'ollama') await unloadAll();
  if (f.provider === 'ollama' && cold) {
    entry.cold = await once(f, cases[0]);
    console.log(`frío (${cases[0].id}): ${entry.cold.ms} ms [${entry.cold.detail}]${entry.cold.error ? ` · ${entry.cold.error}` : ''}`);
  } else {
    // Calentamiento: la primera petición carga el modelo o abre la conexión.
    await once(f, cases[0]);
  }
  for (const c of cases) {
    const runs = [];
    for (let i = 0; i < reps; i++) runs.push(await once(f, c));
    const ok = runs.filter((r) => !r.error);
    const row = {
      id: c.id,
      input: c.text,
      ms: median((ok.length ? ok : runs).map((r) => r.ms)),
      output: ok[0]?.text ?? null,
      error: runs.find((r) => r.error)?.error ?? null,
      // Con temperatura 0 la salida debería ser estable; si no, se anota.
      variants: new Set(ok.map((r) => r.text)).size,
      detail: ok[0]?.detail ?? null,
    };
    entry.cases.push(row);
    console.log(`${c.id} ${row.ms} ms${row.detail ? ` [${row.detail}]` : ''}${row.variants > 1 ? ` (${row.variants} variantes)` : ''}\n  < ${c.text}\n  > ${row.output ?? row.error}`);
  }
  if (f.provider === 'ollama') {
    entry.memory = await ollamaMemory(f.model);
    entry.runner = await runnerOf(f.model);
    console.log(`memoria: Ollama dice ${entry.memory.ollamaMB} MB; proceso ${entry.memory.footprintMB} MB (residente ${entry.memory.rssMB} MB); motor ${entry.runner}`);
  }
  results.push(entry);
}
if (outFile) writeFileSync(resolve(outFile), JSON.stringify(results, null, 1));
