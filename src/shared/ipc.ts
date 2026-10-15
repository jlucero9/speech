// Canales IPC entre ventanas y main. El preload solo expone estos; no hay un
// puente genérico que acepte cualquier nombre de canal.

import type { Preferences } from './preferences';
import type { SharedState } from './state';
import type { HistoryEntry } from './transcription';

export const IPC = {
  getState: 'state:get',
  stateChanged: 'state:changed',
  setPreference: 'prefs:set',
  requestAccessibility: 'permissions:request-accessibility',
  requestMicrophone: 'permissions:request-microphone',
  openAccessibilitySettings: 'permissions:open-accessibility-settings',
  retryHelper: 'helper:retry',
  requestInputMonitoring: 'permissions:request-input-monitoring',
  openInputMonitoringSettings: 'permissions:open-input-monitoring-settings',
  openKeyboardSettings: 'settings:open-keyboard',
  revealRecording: 'dictation:reveal-recording',
  downloadModel: 'transcription:download-model',
  listHistory: 'history:list',
} as const;

/** Canales de la ventana de grabación (preload/recorder.ts). */
export const RECORDER_IPC = {
  /** main → grabación: RecorderCommand. */
  command: 'recorder:command',
  /** grabación → main: RecorderEvent. */
  event: 'recorder:event',
  /** grabación → main: un trozo de audio (id, índice, PCM, volumen). */
  chunk: 'recorder:chunk',
} as const;

export type RecorderCommand = { type: 'start'; id: string } | { type: 'stop'; id: string };

export type RecorderEvent =
  | { type: 'ready' }
  | { type: 'started'; id: string; openMs: number; sampleRate: number; device: string }
  | { type: 'failed'; id: string; error: string }
  /** Muestras todas a cero durante 5 s seguidos. */
  | { type: 'silent'; id: string }
  | { type: 'done'; id: string; chunks: number };

/** API que el preload de la ventana de grabación publica como window.recorder. */
export interface RecorderApi {
  onCommand(listener: (command: RecorderCommand) => void): void;
  send(event: RecorderEvent): void;
  /** PCM de 16 bits con signo, 16 kHz, mono. `volume` en dBFS. */
  chunk(id: string, index: number, pcm: ArrayBuffer, volume: number): void;
}

/** API que el preload publica como window.speech. */
export interface SpeechApi {
  getState(): Promise<SharedState>;
  /** Devuelve la función para darse de baja. */
  onState(listener: (state: SharedState) => void): () => void;
  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void>;
  requestAccessibility(): Promise<void>;
  requestMicrophone(): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  retryHelper(): Promise<void>;
  requestInputMonitoring(): Promise<void>;
  openInputMonitoringSettings(): Promise<void>;
  openKeyboardSettings(): Promise<void>;
  /** Muestra en el Finder el audio de un dictado del historial, o el del último. */
  revealRecording(id?: string): Promise<void>;
  /** Empieza o reanuda la descarga del modelo elegido. */
  downloadModel(): Promise<void>;
  /** Los últimos dictados, del más reciente al más antiguo. */
  listHistory(limit: number): Promise<HistoryEntry[]>;
}
