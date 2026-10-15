import type { RecorderApi, RecorderCommand } from '../../shared/ipc';
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

declare global {
  interface Window {
    recorder: RecorderApi;
  }
}

const SAMPLE_RATE = 16_000;
/** 125 trozos de 40 ms: 5 s con todas las muestras a cero. */
const SILENT_CHUNKS = 125;

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

async function start(id: string): Promise<void> {
  if (session) await stop(session.id);
  const t0 = performance.now();
  let stream: MediaStream | null = null;
  try {
    const { ctx, loaded } = audioContext();
    [stream] = await Promise.all([
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      }),
      loaded,
    ]);
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
      device: track?.label || 'unknown device',
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

api.onCommand((command: RecorderCommand) => {
  queue = queue
    .then(() => (command.type === 'start' ? start(command.id) : stop(command.id)))
    .catch((err) => console.error('Recorder command failed', err));
});

api.send({ type: 'ready' });
