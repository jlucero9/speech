import { SAMPLE_RATE } from './wav';

// ¿Hay voz en lo grabado? Con silencio o ruido de fondo, whisper se inventa
// frases con buena pinta («Gracias.», «Gracias por ver el video.» o la propia
// pista), que se pegarían como si se hubieran dictado. Su indicio de «sin voz»
// no sirve con la configuración de la app, así que se mira la energía: cuenta
// el tiempo en tramos de 30 ms que superan a la vez un nivel absoluto y el
// ruido de fondo de la propia grabación. Medido con el micrófono del MacBook
// Air: los dictados reales dan más de 1 s; los vacíos, menos de 0,1 s. El
// ruido constante no cuenta aunque sea fuerte, porque no sobresale del fondo.

const FRAME_MS = 30;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
const MIN_LEVEL_DB = -45;
const ABOVE_FLOOR_DB = 12;
/** Menos que esto no es una palabra. */
export const MIN_SPEECH_MS = 150;

export interface VoiceCheck {
  speechMs: number;
  /** Ruido de fondo: el décimo percentil de los tramos, en dBFS. */
  floorDb: number;
  peakDb: number;
}

/** `pcm`: 16 bits con signo, mono, 16 kHz. */
export function checkVoice(pcm: Buffer): VoiceCheck {
  const aligned = pcm.byteOffset % 2 === 0 ? pcm : Buffer.from(pcm);
  const samples = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.length / 2));
  const levels: number[] = [];
  for (let start = 0; start + FRAME_SAMPLES <= samples.length; start += FRAME_SAMPLES) {
    let sum = 0;
    for (let i = start; i < start + FRAME_SAMPLES; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / FRAME_SAMPLES);
    levels.push(20 * Math.log10(Math.max(rms, 1) / 32768));
  }
  if (!levels.length) return { speechMs: 0, floorDb: -Infinity, peakDb: -Infinity };
  const sorted = [...levels].sort((a, b) => a - b);
  const floorDb = sorted[Math.floor(sorted.length / 10)];
  const threshold = Math.max(MIN_LEVEL_DB, floorDb + ABOVE_FLOOR_DB);
  const speechMs = levels.filter((db) => db > threshold).length * FRAME_MS;
  return { speechMs, floorDb, peakDb: sorted[sorted.length - 1] };
}
