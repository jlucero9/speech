import type { BarSound } from '../../shared/bar';

// Sonidos de la barra, sintetizados al momento: unas pocas notas senoidales
// con ataque corto y caída exponencial. No hay ficheros de audio.
//
// El contexto de audio se crea con el primer sonido y se suspende a los pocos
// segundos de silencio, para no tener la salida de audio abierta sin motivo.
// Los de empezar y terminar son cortos y suaves: el micrófono se abre justo
// después del de empezar y no conviene que lo recoja.

const SUSPEND_AFTER_MS = 3_000;

interface Note {
  /** Segundos desde el inicio del sonido. */
  at: number;
  freq: number;
  /** Duración de la caída, en segundos. */
  decay: number;
  gain: number;
  type?: OscillatorType;
  /** Armónicos: múltiplo de la frecuencia y su volumen relativo. */
  partials?: [number, number][];
}

const SOUNDS: Record<BarSound, Note[]> = {
  // Dos notas que suben (quinta justa).
  start: [
    { at: 0, freq: 659.3, decay: 0.07, gain: 0.16 },
    { at: 0.045, freq: 987.8, decay: 0.09, gain: 0.14 },
  ],
  // Las mismas, bajando.
  stop: [
    { at: 0, freq: 987.8, decay: 0.07, gain: 0.13 },
    { at: 0.045, freq: 659.3, decay: 0.1, gain: 0.14 },
  ],
  // Manos libres: tres notas rápidas hacia arriba, como un cierre que encaja.
  lock: [
    { at: 0, freq: 784, decay: 0.06, gain: 0.12 },
    { at: 0.04, freq: 987.8, decay: 0.06, gain: 0.12 },
    { at: 0.08, freq: 1318.5, decay: 0.12, gain: 0.12 },
  ],
  // Aviso genérico: una campanilla.
  notice: [
    {
      at: 0,
      freq: 1046.5,
      decay: 0.42,
      gain: 0.18,
      partials: [
        [2, 0.28],
        [3, 0.08],
      ],
    },
    { at: 0.09, freq: 1568, decay: 0.36, gain: 0.1, partials: [[2, 0.2]] },
  ],
  // Atención: dos notas que bajan, algo más llenas.
  alert: [
    { at: 0, freq: 880, decay: 0.16, gain: 0.16, type: 'triangle' },
    { at: 0.13, freq: 698.5, decay: 0.22, gain: 0.16, type: 'triangle' },
  ],
  // Error: dos notas graves en tercera menor descendente.
  error: [
    { at: 0, freq: 392, decay: 0.16, gain: 0.2, type: 'triangle', partials: [[2, 0.25]] },
    { at: 0.14, freq: 311.1, decay: 0.26, gain: 0.2, type: 'triangle', partials: [[2, 0.25]] },
  ],
};

let ctx: AudioContext | null = null;
let suspendTimer: number | undefined;

function context(): AudioContext {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function playSound(sound: BarSound, volume = 1): void {
  const c = context();
  const t0 = c.currentTime + 0.01;
  let end = t0;
  for (const n of SOUNDS[sound]) {
    for (const [mult, rel] of [[1, 1], ...(n.partials ?? [])] as [number, number][]) {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = n.type ?? 'sine';
      osc.frequency.value = n.freq * mult;
      const start = t0 + n.at;
      const peak = n.gain * rel * volume;
      // Ataque de 5 ms y caída exponencial; acaba a -60 dB.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.005);
      const stop = start + 0.005 + n.decay * 6.9 * 0.5;
      gain.gain.exponentialRampToValueAtTime(0.0001, stop);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(stop + 0.02);
      end = Math.max(end, stop);
    }
  }
  window.clearTimeout(suspendTimer);
  const wait = (end - c.currentTime) * 1000 + SUSPEND_AFTER_MS;
  suspendTimer = window.setTimeout(() => void ctx?.suspend(), wait);
}
