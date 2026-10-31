// Estado compartido: main es la única fuente de verdad y cada ventana recibe
// una copia completa en cada cambio (es pequeño). Las ventanas no lo modifican
// directamente: piden acciones por IPC (ver ipc.ts).

import type { BarState } from './bar';
import type { FormattingState } from './formatting';
import type { FnUsage, HelperPasteResult } from './helper-protocol';
import type { Preferences } from './preferences';
import type { TranscriptionState } from './transcription';

export type HelperStatus =
  | 'starting' // proceso lanzado, esperando el primer ACK
  | 'ready' // responde a IsReady
  | 'restarting' // murió o dejó de responder; relanzado programado
  | 'failed' // agotó los reintentos; solo se relanza a mano
  | 'stopped'; // la app se está cerrando

export interface HelperState {
  status: HelperStatus;
  pid: number | null;
  /** Relanzamientos desde el último periodo estable. */
  restarts: number;
  /** Hora (ms) del próximo intento si status es 'restarting'. */
  nextAttemptAt: number | null;
  lastError: string | null;
}

/** 'unknown' mientras el helper no ha contestado. */
export type AccessibilityPermission = 'granted' | 'denied' | 'unknown';

/** Valores de systemPreferences.getMediaAccessStatus de Electron. */
export type MicrophonePermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export interface DataState {
  databaseReady: boolean;
  schemaVersion: number;
  /** Migraciones aplicadas en este arranque (0 si la base ya estaba al día). */
  migrationsAppliedThisLaunch: number;
  error: string | null;
}

/** 'unknown': el helper no está en marcha o aún no ha contestado. */
export type TapState = 'active' | 'no-permission' | 'failed' | 'unknown';

export interface SecureInputOwner {
  pid: number;
  appName: string | null;
  bundleId: string | null;
  since: number;
}

export interface KeyboardState {
  tap: TapState;
  /** Motivo del último cambio del tap, para el registro y la ventana. */
  tapReason: string | null;
  /** Monitorización de entrada. Solo se pide si el tap no se puede crear sin ella. */
  inputMonitoring: 'granted' | 'denied' | 'unknown';
  /** App que tiene la entrada segura activa y bloquea el atajo, o null. */
  secureInput: SecureInputOwner | null;
  fnUsage: FnUsage;
}

// Estados del dictado. «initializing»: abriendo el micrófono; «stopping»:
// esperando los últimos trozos; «processing»: guardando y transcribiendo.
// Cancelar vuelve directamente a «idle».
export type DictationStatus = 'idle' | 'initializing' | 'listening' | 'stopping' | 'processing';

export type DictationOutcome =
  | 'done' // transcrito y guardado en el historial (el texto puede estar vacío si no se oyó nada)
  | 'cancelled' // cancelado por el usuario (el audio se guarda si dura ≥ 0,5 s)
  | 'discarded' // descartado sin audio útil: toque corto, otra combinación…
  | 'failed'; // no pudo arrancar, grabar o transcribir; el audio se conserva si llegó a guardarse

/**
 * Cómo acabó el pegado de un dictado: los resultados del helper y además
 * `pending` (⌘V enviado, sin resultado aún), `empty` (no había texto que
 * pegar) y `failed` (el helper no respondió; main dejó el texto en el
 * portapapeles).
 */
export type PasteResult = HelperPasteResult | 'pending' | 'empty' | 'failed';

export interface PasteInfo {
  result: PasteResult;
  appName: string | null;
  /** Desde soltar la tecla hasta que la app pidió el texto. */
  ms: number | null;
}

export interface FormatInfo {
  /** 'formatted', 'off' o 'raw_<motivo>' (se pegó la transcripción tal cual). */
  result: string;
  model: string | null;
  ms: number | null;
}

export interface DictationResult {
  id: string;
  outcome: DictationOutcome;
  /** Motivo en clave (`debounce_ptt`, `user_action_escape`, `no_audio`…). */
  reason: string;
  /** Texto para la ventana, en inglés. */
  message: string;
  durationMs: number;
  file: string | null;
  /** Texto que se pegó (formateado y ajustado al campo), o el transcrito si no se llegó a pegar. */
  text: string | null;
  /** Transcripción tal cual. */
  rawText: string | null;
  /** Cómo acabó el formateo; null si no se llegó a formatear. */
  format: FormatInfo | null;
  /** Idioma del texto (el elegido o el detectado). */
  language: string | null;
  /** Desde que acabó la grabación hasta tener el texto. */
  transcriptionMs: number | null;
  /** null si no se llegó a pegar (cancelado, fallido…). */
  paste: PasteInfo | null;
  at: number;
}

export interface DictationState {
  status: DictationStatus;
  id: string | null;
  startedAt: number | null;
  /** Manos libres (doble pulsación): no hace falta mantener la tecla. */
  handsFree: boolean;
  /** Nivel de entrada de 0 a 1, cada 150 ms mientras escucha. */
  level: number;
  /** Todas las muestras a cero durante 5 s: el micrófono no da señal. */
  micSilent: boolean;
  last: DictationResult | null;
}

export interface MicrophoneDevice {
  id: string;
  label: string;
}

export interface MicrophonesState {
  /** Micrófonos conectados, sin el «por defecto» del sistema. */
  devices: MicrophoneDevice[];
  /** Nombre del que el sistema usa por defecto, si se sabe. */
  systemDefault: string | null;
  /** Con qué micrófono se grabó el último dictado. */
  lastUsed: string | null;
}

/** Grabación de un atajo en el editor: teclas pulsadas y nombres en la distribución actual. */
export interface ShortcutRecording {
  /** Teclas pulsadas ahora. */
  held: number[];
  /** Al soltarlas todas: la combinación que se pulsó (lo máximo que hubo a la vez). */
  done: number[] | null;
  names: Record<string, string>;
}

export interface SharedState {
  /** Versión de la app. */
  version: string;
  helper: HelperState;
  permissions: {
    accessibility: AccessibilityPermission;
    microphone: MicrophonePermission;
  };
  keyboard: KeyboardState;
  dictation: DictationState;
  transcription: TranscriptionState;
  formatting: FormattingState;
  bar: BarState;
  microphones: MicrophonesState;
  data: DataState;
  prefs: Preferences;
}
