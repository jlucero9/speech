import type { RecorderApi, RecorderCommand, RecorderDevice } from '../../shared/ipc';
import workletUrl from './worklet.js?url';

// Captura del micrófono en la ventana oculta.
//
// El AudioContext (16 kHz, sin salida de audio) y el micrófono se abren al
// empezar cada dictado y se cierran al terminar: fuera del dictado no hay
// indicador de micrófono, y sin contexto abierto el proceso de audio de
// Chromium puede cerrarse. Crear el contexto cuesta unos milisegundos.
//
// Audio crudo: sin cancelación de eco, supresión de ruido ni control de
// ganancia. Las órdenes se atienden en orden, una tras otra.
//
// Micrófono: el elegido en ajustes, buscado por su id y, si cambió (al volver
// a conectarlo), por su nombre; si no está, el del sistema. También avisa a
// main de los micrófonos conectados y mide el nivel de uno mientras el
// diálogo de ajustes lo pide (nunca durante un dictado).

declare global {
  interface Window {
    recorder: RecorderApi;
  }
}

const SAMPLE_RATE = 16_000;
/** 125 trozos de 40 ms: 5 s con todas las muestras a cero. */
const SILENT_CHUNKS = 125;
const MONITOR_EVERY_MS = 100;
/** El mismo suelo que el nivel de la barra. */
const LEVEL_FLOOR_DB = -60;

interface Session {
  id: string;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  index: number;
  zeroRun: number;
  silentSent: boolean;
  done: Promise<void>;
}

const api = window.recorder;
let context: AudioContext | null = null;
let moduleLoaded: Promise<void> | null = null;
let session: Session | null = null;
let queue: Promise<void> = Promise.resolve();
let monitor: { stream: MediaStream; ctx: AudioContext; timer: ReturnType<typeof setInterval> } | null = null;

const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };

/** Restricciones para abrir el micrófono elegido, o el del sistema si ya no está. */
async function constraints(device: RecorderDevice): Promise<MediaTrackConstraints> {
  if (!device) return RAW_AUDIO;
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const found = inputs.find((d) => d.deviceId === device.id) ?? inputs.find((d) => d.label === device.label);
  if (!found) {
    console.warn(`Microphone "${device.label}" is not connected; using the system default`);
    return RAW_AUDIO;
  }
  return { ...RAW_AUDIO, deviceId: { exact: found.deviceId } };
}

async function reportDevices(): Promise<void> {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const def = inputs.find((d) => d.deviceId === 'default');
  api.send({
    type: 'devices',
    devices: inputs
      .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label)
      .map((d) => ({ id: d.deviceId, label: d.label })),
    systemDefault: def?.label.replace(/^Default - /, '') || null,
  });
}

async function startMonitor(device: RecorderDevice): Promise<void> {
  await stopMonitor();
  if (session) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: await constraints(device) });
    const ctx = new AudioContext({ latencyHint: 'playback', sinkId: { type: 'none' } } as AudioContextOptions);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-10);
      api.send({ type: 'level', level: Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB)) });
    }, MONITOR_EVERY_MS);
    monitor = { stream, ctx, timer };
  } catch (err) {
    const e = err as DOMException;
    console.warn(`Could not open the microphone to measure it: ${e.name}: ${e.message}`);
    api.send({ type: 'level', level: 0 });
  }
}

async function stopMonitor(): Promise<void> {
  const m = monitor;
  monitor = null;
  if (!m) return;
  clearInterval(m.timer);
  m.stream.getTracks().forEach((t) => t.stop());
  await m.ctx.close().catch(() => {});
}

function audioContext(): { ctx: AudioContext; loaded: Promise<void> } {
  if (!context || context.state === 'closed') {
    // Sin dispositivo de salida: el grafo avanza con un reloj propio.
    context = new AudioContext({
      sampleRate: SAMPLE_RATE,
      latencyHint: 'interactive',
      sinkId: { type: 'none' },
    } as AudioContextOptions);
    moduleLoaded = context.audioWorklet.addModule(workletUrl);
  }
  return { ctx: context, loaded: moduleLoaded! };
}

async function closeContext(): Promise<void> {
  const ctx = context;
  context = null;
  moduleLoaded = null;
  if (ctx && ctx.state !== 'closed') await ctx.close();
}

async function start(id: string, device: RecorderDevice): Promise<void> {
  if (session) await stop(session.id);
  // Medir y dictar a la vez no: el dictado manda.
  await stopMonitor();
  const t0 = performance.now();
  let stream: MediaStream | null = null;
  try {
    const { ctx, loaded } = audioContext();
    [stream] = await Promise.all([navigator.mediaDevices.getUserMedia({ audio: await constraints(device) }), loaded]);
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    let resolveDone!: () => void;
    const s: Session = {
      id,
      stream,
      source,
      node,
      index: 0,
      zeroRun: 0,
      silentSent: false,
      done: new Promise((r) => (resolveDone = r)),
    };
    node.port.onmessage = (e: MessageEvent<{ pcm?: ArrayBuffer; volume?: number; zero?: boolean; done?: boolean }>) => {
      const m = e.data;
      if (m.done) {
        resolveDone();
        return;
      }
      if (!m.pcm) return;
      api.chunk(id, s.index++, m.pcm, m.volume ?? -200);
      s.zeroRun = m.zero ? s.zeroRun + 1 : 0;
      if (s.zeroRun >= SILENT_CHUNKS && !s.silentSent) {
        s.silentSent = true;
        api.send({ type: 'silent', id });
      }
    };
    source.connect(node).connect(ctx.destination);
    session = s;
    const track = stream.getAudioTracks()[0];
    api.send({
      type: 'started',
      id,
      openMs: Math.round(performance.now() - t0),
      sampleRate: ctx.sampleRate,
      // El del sistema se llama «Default - <nombre>»: es el mismo micrófono.
      device: track?.label.replace(/^Default - /, '') || 'unknown device',
    });
    track?.addEventListener('ended', () => {
      if (session === s) api.send({ type: 'failed', id, error: 'the microphone was disconnected' });
    });
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    await closeContext().catch(() => {});
    const e = err as DOMException;
    api.send({ type: 'failed', id, error: `${e.name}: ${e.message}` });
  }
}

async function stop(id: string): Promise<void> {
  const s = session;
  if (!s || s.id !== id) {
    // Nada abierto con ese id (falló al abrir o ya se cerró).
    api.send({ type: 'done', id, chunks: 0 });
    return;
  }
  session = null;
  s.node.port.postMessage('flush');
  // El worklet responde en el siguiente bloque (8 ms); por si no, un tope.
  await Promise.race([s.done, new Promise((r) => setTimeout(r, 500))]);
  s.source.disconnect();
  s.node.disconnect();
  s.node.port.onmessage = null;
  s.stream.getTracks().forEach((t) => t.stop());
  api.send({ type: 'done', id, chunks: s.index });
  await closeContext();
}

function run(command: RecorderCommand): Promise<void> {
  switch (command.type) {
    case 'start':
      return start(command.id, command.device);
    case 'stop':
      return stop(command.id);
    case 'monitor':
      return startMonitor(command.device);
    case 'monitor-stop':
      return stopMonitor();
  }
}

api.onCommand((command: RecorderCommand) => {
  queue = queue.then(() => run(command)).catch((err) => console.error('Recorder command failed', err));
});

navigator.mediaDevices.addEventListener('devicechange', () => void reportDevices().catch(() => {}));

api.send({ type: 'ready' });
void reportDevices().catch((err) => console.warn('Could not list microphones', err));
