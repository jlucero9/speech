import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { logger } from '../log';
import { SAMPLE_RATE } from './wav';

// ¿Hay voz en lo grabado? Con silencio o ruido de fondo, whisper se inventa
// frases con buena pinta («Gracias.», «Gracias por ver el video.» o la propia
// pista), que se pegarían como si se hubieran dictado. Su indicio de «sin voz»
// no sirve con la configuración de la app, así que se mira la energía: cuenta
// el tiempo en tramos de 30 ms que superan a la vez un nivel mínimo y el ruido
// de fondo de la propia grabación. El ruido constante no cuenta aunque sea
// fuerte, porque no sobresale del fondo.
//
// El nivel mínimo depende del micrófono. Con el del MacBook Air (la voz ronda
// los −31 dBFS) es −45 dBFS: deja fuera voces lejanas (un vídeo de fondo) y los
// dictados vacíos dan menos de 0,1 s. Pero un micrófono 15–20 dB más bajo deja
// la voz entera por debajo de −45 y un dictado real parecería vacío. Por eso
// se recuerda el nivel típico de la voz en cada micrófono (por su nombre) y el
// mínimo queda 14 dB por debajo, entre −60 y −45 dBFS. Con un micrófono aún
// sin medir, −60: antes dejar pasar un dictado dudoso que perder uno bueno.

const log = logger('voice');

const FRAME_MS = 30;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;
/** Mínimo con el micrófono de referencia y el más bajo que se admite. */
const MAX_GATE_DB = -45;
const MIN_GATE_DB = -60;
/** El mínimo queda tanto por debajo de la voz típica del micrófono. */
const GATE_BELOW_VOICE_DB = 14;
const ABOVE_FLOOR_DB = 12;
/** Por debajo, silencio digital (el micrófono aún abriéndose): no cuenta para el fondo. */
const DIGITAL_SILENCE_DB = -88;
/** Menos que esto no es una palabra. */
export const MIN_SPEECH_MS = 150;
/** Para aprender el nivel de un micrófono hace falta al menos esta voz. */
const LEARN_MIN_MS = 500;
/** Peso de cada dictado nuevo en el nivel recordado. */
const LEARN_WEIGHT = 0.3;
/**
 * Los sonidos de la app (empezar, manos libres) también llegan al micrófono
 * y bastan para superar el umbral: no se cuenta lo grabado desde un poco
 * antes de cada uno hasta que se apaga.
 */
const OWN_SOUND_BEFORE_MS = 50;
const OWN_SOUND_AFTER_MS = 700;

export interface VoiceCheck {
  speechMs: number;
  /** Ruido de fondo: el décimo percentil de los tramos con señal, en dBFS. */
  floorDb: number;
  peakDb: number;
  /** Nivel mínimo usado. */
  gateDb: number;
  /** Mediana de los tramos que superan el mínimo más bajo y el fondo; null si casi no hay. */
  voiceDb: number | null;
}

/**
 * `pcm`: 16 bits con signo, mono, 16 kHz. `ownSoundsMs`: cuándo sonó la app,
 * en milisegundos desde el principio de la grabación. `voiceDb`: nivel típico
 * de la voz en este micrófono, si se conoce.
 */
export function checkVoice(pcm: Buffer, ownSoundsMs: number[] = [], voiceDb: number | null = null): VoiceCheck {
  const aligned = pcm.byteOffset % 2 === 0 ? pcm : Buffer.from(pcm);
  const samples = new Int16Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.length / 2));
  const levels: number[] = [];
  const ownSound = (ms: number): boolean =>
    ownSoundsMs.some((t) => ms + FRAME_MS > t - OWN_SOUND_BEFORE_MS && ms < t + OWN_SOUND_AFTER_MS);
  for (let start = 0; start + FRAME_SAMPLES <= samples.length; start += FRAME_SAMPLES) {
    if (ownSound((start / FRAME_SAMPLES) * FRAME_MS)) continue;
    let sum = 0;
    for (let i = start; i < start + FRAME_SAMPLES; i++) sum += samples[i] * samples[i];
    const rms = Math.sqrt(sum / FRAME_SAMPLES);
    levels.push(20 * Math.log10(Math.max(rms, 1) / 32768));
  }
  const gateDb = gateFor(voiceDb);
  const audible = levels.filter((db) => db > DIGITAL_SILENCE_DB).sort((a, b) => a - b);
  if (!audible.length) return { speechMs: 0, floorDb: -Infinity, peakDb: -Infinity, gateDb, voiceDb: null };
  const floorDb = audible[Math.floor(audible.length / 10)];
  const above = (gate: number) => levels.filter((db) => db > Math.max(gate, floorDb + ABOVE_FLOOR_DB));
  const speechMs = above(gateDb).length * FRAME_MS;
  const loose = above(MIN_GATE_DB).sort((a, b) => a - b);
  return {
    speechMs,
    floorDb,
    peakDb: audible[audible.length - 1],
    gateDb,
    voiceDb: loose.length * FRAME_MS >= LEARN_MIN_MS ? loose[Math.floor(loose.length / 2)] : null,
  };
}

function gateFor(voiceDb: number | null): number {
  if (voiceDb == null) return MIN_GATE_DB;
  return Math.min(MAX_GATE_DB, Math.max(MIN_GATE_DB, voiceDb - GATE_BELOW_VOICE_DB));
}

/** Nivel típico de la voz en cada micrófono, guardado en voice-levels.json. */
export class VoiceLevels {
  private levels: Record<string, number> = {};

  constructor(private readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'number' && Number.isFinite(v)) this.levels[k] = v;
    } catch {
      // Sin fichero: aún no se ha medido ningún micrófono.
    }
  }

  get(device: string | null): number | null {
    return device ? (this.levels[device] ?? null) : null;
  }

  /**
   * Anota la voz de un dictado con este micrófono. Si el dictado se descartó
   * por quedar bajo el mínimo pero tenía voz (se bajó el volumen de entrada),
   * se adopta su nivel de golpe para no perder también el siguiente.
   */
  learn(device: string | null, voiceDb: number | null, rejected = false): void {
    if (!device || voiceDb == null) return;
    const prev = this.levels[device];
    const next = prev == null || rejected ? voiceDb : prev * (1 - LEARN_WEIGHT) + voiceDb * LEARN_WEIGHT;
    this.levels[device] = Math.round(next * 10) / 10;
    if (prev == null || rejected) log.info(`Voice level for "${device}": ${this.levels[device]} dBFS${rejected ? ' (was too quiet for the previous level)' : ''}`);
    try {
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.levels, null, 2) + '\n');
      renameSync(`${this.path}.tmp`, this.path);
    } catch (err) {
      log.warn(`Could not save voice levels: ${(err as Error).message}`);
    }
  }

}
