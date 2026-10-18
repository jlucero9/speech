// Datos de la transcripción que comparten main y la interfaz: modelos locales,
// idiomas y entradas del historial.

import type { PasteResult } from './state';

/**
 * Modelos de whisper.cpp que la app sabe descargar. Solo uno: los más pequeños
 * se equivocan demasiado en español para compensar lo que ahorran.
 */
export const LOCAL_MODELS = {
  'large-v3-turbo-q5_0': {
    label: 'Large v3 Turbo',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sizeBytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
} as const;

export type LocalModelId = keyof typeof LOCAL_MODELS;

export const DEFAULT_LOCAL_MODEL: LocalModelId = 'large-v3-turbo-q5_0';

export function isLocalModelId(value: unknown): value is LocalModelId {
  return typeof value === 'string' && Object.hasOwn(LOCAL_MODELS, value);
}

/**
 * Idiomas del dictado. Siempre hay uno elegido: detectarlo en cada dictado
 * cuesta una pasada más del modelo (hasta 1,6 s en un dictado largo). Los
 * códigos son los de whisper (ISO 639-1).
 */
export const DICTATION_LANGUAGES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  ca: 'Catalan',
  pt: 'Portuguese',
  fr: 'French',
  it: 'Italian',
  de: 'German',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  ar: 'Arabic',
  hi: 'Hindi',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
};

export function isDictationLanguage(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(DICTATION_LANGUAGES, value);
}

/** El primero de los idiomas del sistema que se puede dictar; si no hay ninguno, inglés. */
export function defaultDictationLanguage(systemLanguages: readonly string[]): string {
  for (const tag of systemLanguages) {
    const code = tag.split('-')[0].toLowerCase();
    if (isDictationLanguage(code)) return code;
  }
  return 'en';
}

export type ModelStatus =
  | 'checking' // comprobando el fichero al arrancar
  | 'missing' // no está y aún no se ha empezado a descargar
  | 'downloading'
  | 'verifying' // calculando el hash
  | 'ready'
  | 'failed'; // la descarga o la comprobación fallaron; ver error

export interface ModelState {
  id: LocalModelId;
  status: ModelStatus;
  receivedBytes: number;
  totalBytes: number;
  bytesPerSecond: number | null;
  error: string | null;
  /** Hora (ms) del próximo reintento automático, si hay uno programado. */
  retryAt: number | null;
}

export type TranscriberStatus =
  | 'stopped' // sin proceso: el modelo no ocupa memoria
  | 'loading'
  | 'ready' // modelo cargado, esperando
  | 'busy' // transcribiendo
  | 'failed';

export interface TranscriberState {
  status: TranscriberStatus;
  pid: number | null;
  /** Memoria del proceso (la del Monitor de Actividad). */
  memoryBytes: number | null;
  /** Hora (ms) a la que se cerrará si no llega otro dictado. */
  unloadAt: number | null;
  error: string | null;
}

export interface TranscriptionState {
  /** Motor activo. De momento solo el local. */
  engine: 'local';
  model: ModelState;
  transcriber: TranscriberState;
}

export type HistoryStatus = 'recording' | 'processing' | 'done' | 'cancelled' | 'failed';

/** Una fila del historial, tal como la ve la interfaz. */
export interface HistoryEntry {
  id: string;
  createdAt: number;
  status: HistoryStatus;
  durationMs: number | null;
  audioPath: string | null;
  text: string | null;
  language: string | null;
  engine: string | null;
  model: string | null;
  transcriptionMs: number | null;
  /** Texto que se envió a pegar. */
  pastedText: string | null;
  /** App en la que se pegó (o se intentó). */
  appName: string | null;
  pasteResult: PasteResult | null;
  /** Desde soltar la tecla hasta que la app pidió el texto. */
  pasteMs: number | null;
  error: string | null;
  /** Texto formateado; null si no se formateó. */
  formattedText: string | null;
  /** 'formatted', 'off' o 'raw_<motivo>' (se pegó la transcripción tal cual). */
  formatResult: string | null;
  formatModel: string | null;
  formatMs: number | null;
  formatError: string | null;
}
