// Mide la transcripción local con SpeechTranscriber, sin abrir la app.
//
//   npm run medir -- --models a.bin,b.bin --audio corta.wav,larga.wav [--language es] [--reps 3]
//                    [--beam 5] [--warmup] [--trim]
//
// Para cada modelo y cada audio:
//   frío:     proceso nuevo → carga del modelo → transcripción (tiempo total
//             desde que se lanza el proceso hasta tener el texto)
//   cargado:  mediana de --reps transcripciones más con el modelo ya en memoria
// y la memoria del proceso (phys_footprint, la del Monitor de Actividad) tras
// cargar y en el pico.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const BIN = resolve(homedir(), 'Library/Developer/Speech/transcriber/SpeechTranscriber');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

const models = String(arg('models', '')).split(',').filter(Boolean).map((p) => resolve(p));
const audios = String(arg('audio', '')).split(',').filter(Boolean).map((p) => resolve(p));
const language = String(arg('language', 'auto'));
const reps = Number(arg('reps', 3));
const beam = Number(arg('beam', 0));
const warmup = arg('warmup', false) === true;
const trim = arg('trim', false) === true;
if (!models.length || !audios.length) {
  console.error('Uso: npm run medir -- --models a.bin,b.bin --audio corta.wav,larga.wav [--language es]');
  process.exit(1);
}

class Worker {
  constructor() {
    this.t0 = performance.now();
    this.proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.pending = new Map();
    this.nextId = 1;
    this.hello = new Promise((r) => (this.onHello = r));
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.type === 'hello') return this.onHello(msg);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(`${msg.code}: ${msg.message}`));
      else p.resolve(msg);
    });
  }
  send(cmd) {
    const id = String(this.nextId++);
    this.proc.stdin.write(JSON.stringify({ ...cmd, id }) + '\n');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  load(model) {
    return this.send({ type: 'load', model, warmup, language });
  }
  transcribe(audio) {
    return this.send({ type: 'transcribe', audio, language, beam, trim });
  }
  close() {
    this.proc.stdin.end();
    return new Promise((r) => this.proc.once('exit', r));
  }
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const mb = (bytes) => Math.round(bytes / 1024 / 1024);
const s = (ms) => (ms / 1000).toFixed(2);

const rows = [];
for (const model of models) {
  for (const audio of audios) {
    // Frío: proceso nuevo para cada audio.
    const w = new Worker();
    await w.hello;
    const loaded = await w.load(model);
    const first = await w.transcribe(audio);
    const coldMs = performance.now() - w.t0;
    const warm = [];
    let last = first;
    for (let i = 0; i < reps; i++) {
      last = await w.transcribe(audio);
      warm.push(last.ms.total);
    }
    await w.close();
    const retried = [first, last].some((r) => r.retried);
    const row = {
      model: basename(model),
      audio: basename(audio),
      audioS: s(first.audioMs),
      loadS: s(loaded.ms),
      warmupS: s(loaded.warmupMs ?? 0),
      firstS: s(first.ms.total),
      coldS: s(coldMs),
      warmS: s(median(warm)),
      encodeS: s(last.ms.encode),
      loadedMB: mb(loaded.memory.footprint),
      peakMB: mb(last.memory.peak ?? last.memory.footprint),
      language: first.language,
      text: first.text + (retried ? ' [repetida con la ventana entera]' : ''),
    };
    rows.push(row);
    console.error(JSON.stringify(row));
  }
}

console.log(
  `\nIdioma: ${language} · ${beam > 1 ? `beam ${beam}` : 'greedy'} · ${reps} repeticiones en caliente${warmup ? ' · con calentamiento' : ''}${trim ? ' · codificador recortado' : ''}\n`,
);
console.log('| Modelo | Audio | Dura | Carga | Calentamiento | 1.ª transcripción | Frío total | Cargado (mediana) | Codificador | Memoria cargado | Pico |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(
    `| ${r.model} | ${r.audio} | ${r.audioS} s | ${r.loadS} s | ${r.warmupS} s | ${r.firstS} s | ${r.coldS} s | ${r.warmS} s | ${r.encodeS} s | ${r.loadedMB} MB | ${r.peakMB} MB |`,
  );
}
console.log('\nTextos (primera transcripción):');
for (const r of rows) console.log(`- ${r.model} · ${r.audio} [${r.language}]: ${r.text}`);
