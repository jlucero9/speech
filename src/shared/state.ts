// Estado compartido: main es la única fuente de verdad y cada ventana recibe
// una copia completa en cada cambio (es pequeño). Las ventanas no lo modifican
// directamente: piden acciones por IPC (ver ipc.ts).

import type { FnUsage } from './helper-protocol';
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

export interface DictationResult {
  id: string;
  outcome: DictationOutcome;
  /** Motivo en clave (`debounce_ptt`, `user_action_escape`, `no_audio`…). */
  reason: string;
  /** Texto para la ventana, en inglés. */
  message: string;
  durationMs: number;
  file: string | null;
  /** Texto transcrito, si se llegó a transcribir. */
  text: string | null;
  /** Idioma del texto (el elegido o el detectado). */
  language: string | null;
  /** Desde que acabó la grabación hasta tener el texto. */
  transcriptionMs: number | null;
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

export interface SharedState {
  helper: HelperState;
  permissions: {
    accessibility: AccessibilityPermission;
    microphone: MicrophonePermission;
  };
  keyboard: KeyboardState;
  dictation: DictationState;
  transcription: TranscriptionState;
  data: DataState;
  prefs: Preferences;
}
