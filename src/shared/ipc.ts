// Canales IPC entre ventanas y main. El preload solo expone estos; no hay un
// puente genérico que acepte cualquier nombre de canal.

import type { BarSound, NoticeAction } from './bar';
import type { ApiKeyResult, CloudProvider } from './engines';
import type { Preferences } from './preferences';
import type { MicrophoneDevice, SharedState, ShortcutRecording } from './state';
import type { HistoryActionResult, HistoryPage, HistoryQuery, HistoryStats } from './history';
import type { DictionaryEntry, DictionaryImportChoice, DictionaryInput, DictionaryResult } from './dictionary';

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
  openMicrophoneSettings: 'permissions:open-microphone-settings',
  listHistory: 'history:list',
  historyStats: 'history:stats',
  historyAudio: 'history:audio',
  copyTranscript: 'history:copy',
  setShowFormatted: 'history:set-show-formatted',
  setFlagged: 'history:set-flagged',
  retryTranscript: 'history:retry',
  deleteTranscript: 'history:delete',
  extractAudio: 'history:extract-audio',
  listDictionary: 'dictionary:list',
  addWord: 'dictionary:add',
  editWord: 'dictionary:edit',
  removeWords: 'dictionary:remove',
  starWord: 'dictionary:star',
  restoreWords: 'dictionary:restore',
  chooseDictionaryFile: 'dictionary:choose-file',
  importDictionary: 'dictionary:import',
  recordShortcut: 'shortcuts:record',
  monitorMicrophone: 'microphone:monitor',
  resetSettings: 'settings:reset',
  saveApiKey: 'keys:save',
  removeApiKey: 'keys:remove',
  allowApiKey: 'keys:allow',
  testApiKey: 'keys:test',
} as const;

/** main → Hub. */
export const HUB_EVENTS = {
  /** El Hub debe enseñar esta página (HubPage). */
  navigate: 'hub:navigate',
  /** El historial cambió: hay que volver a leerlo. */
  historyChanged: 'history:changed',
  /** El diccionario cambió: hay que volver a leerlo. */
  dictionaryChanged: 'dictionary:changed',
  /** Teclas mientras se graba un atajo (ShortcutRecording). */
  shortcutRecording: 'shortcuts:recording',
  /** Nivel del micrófono que se prueba en el diálogo, de 0 a 1. */
  microphoneLevel: 'microphone:level',
} as const;

/**
 * Páginas del Hub. «settings» abre el diálogo de ajustes sobre la página
 * actual, en General; «settings/…», en esa sección.
 */
export const HUB_PAGES = ['dictation', 'dictionary', 'style', 'settings', 'settings/system', 'settings/engines', 'settings/data'] as const;
export type HubPage = (typeof HUB_PAGES)[number];

export function isHubPage(value: unknown): value is HubPage {
  return (HUB_PAGES as readonly unknown[]).includes(value);
}

/** Canales de la barra flotante (preload/bar.ts), además de getState y stateChanged. */
export const BAR_IPC = {
  /** barra → main: el cursor entra (true) o sale (false) de una zona que recibe clics. */
  interactive: 'bar:interactive',
  /** barra → main: BarCommand. */
  command: 'bar:command',
  /** barra → main: arrastre de la píldora, en coordenadas de pantalla. */
  drag: 'bar:drag',
  /** main → barra: un sonido que reproducir (BarSound). */
  sound: 'bar:sound',
  /** main → barra: abrir (true) o cerrar (false) el menú contextual. */
  menu: 'bar:menu',
} as const;

/** Entradas del menú contextual de la barra (además de elegir micrófono). */
export type BarMenuItem = 'hide' | 'settings' | 'history' | 'paste_last';

export type BarCommand =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'menu' } // clic secundario: abrir el menú
  | { type: 'menu-closed' }
  | { type: 'menu-item'; item: BarMenuItem }
  | { type: 'set-microphone'; id: string; label: string }
  | { type: 'notice-action'; id: number; action: NoticeAction }
  | { type: 'notice-closed'; id: number; why: 'closed' | 'timeout' };

export type BarDrag = { phase: 'start' | 'move' | 'end'; x: number; y: number };

/** API que el preload de la barra publica como window.bar. */
export interface BarApi {
  getState(): Promise<SharedState>;
  onState(listener: (state: SharedState) => void): () => void;
  setInteractive(on: boolean): void;
  command(c: BarCommand): void;
  drag(d: BarDrag): void;
  /** Devuelve la función para darse de baja. */
  onSound(listener: (sound: BarSound) => void): () => void;
  onMenu(listener: (open: boolean) => void): () => void;
}

/** Canales de la ventana de grabación (preload/recorder.ts). */
export const RECORDER_IPC = {
  /** main → grabación: RecorderCommand. */
  command: 'recorder:command',
  /** grabación → main: RecorderEvent. */
  event: 'recorder:event',
  /** grabación → main: un trozo de audio (id, índice, PCM, volumen). */
  chunk: 'recorder:chunk',
} as const;

/** Micrófono con el que grabar: null, el del sistema. */
export type RecorderDevice = { id: string; label: string } | null;

export type RecorderCommand =
  | { type: 'start'; id: string; device: RecorderDevice }
  | { type: 'stop'; id: string }
  /** Abre el micrófono solo para medir su nivel (diálogo de ajustes). */
  | { type: 'monitor'; device: RecorderDevice }
  | { type: 'monitor-stop' };

export type RecorderEvent =
  | { type: 'ready' }
  | { type: 'started'; id: string; openMs: number; sampleRate: number; device: string }
  | { type: 'failed'; id: string; error: string }
  /** Muestras todas a cero durante 5 s seguidos. */
  | { type: 'silent'; id: string }
  | { type: 'done'; id: string; chunks: number }
  /** Micrófonos conectados (al arrancar y cada vez que cambian). */
  | { type: 'devices'; devices: MicrophoneDevice[]; systemDefault: string | null }
  /** Nivel del micrófono que se mide, de 0 a 1. */
  | { type: 'level'; level: number };

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
  /** Abre Ajustes del Sistema en Privacidad › Micrófono. */
  openMicrophoneSettings(): Promise<void>;
  /** Devuelve la función para darse de baja. */
  onNavigate(listener: (page: HubPage) => void): () => void;
  /** Devuelve la función para darse de baja. */
  onHistoryChanged(listener: () => void): () => void;
  /** Dictados del más reciente al más antiguo. */
  listHistory(q: HistoryQuery): Promise<HistoryPage>;
  historyStats(): Promise<HistoryStats>;
  /** El WAV de un dictado, o null si ya no está. */
  historyAudio(id: string): Promise<Uint8Array | null>;
  copyTranscript(id: string): Promise<HistoryActionResult>;
  /** false: «Undo AI edit» (se enseña la transcripción); true: «Redo AI edit». */
  setShowFormatted(id: string, show: boolean): Promise<void>;
  setFlagged(id: string, flagged: boolean): Promise<void>;
  retryTranscript(id: string): Promise<HistoryActionResult>;
  deleteTranscript(id: string): Promise<HistoryActionResult>;
  /** Pide dónde guardar el audio y lo copia allí. ok sin mensaje si se cancela. */
  extractAudio(id: string): Promise<HistoryActionResult & { saved?: boolean }>;
  /** Devuelve la función para darse de baja. */
  onDictionaryChanged(listener: () => void): () => void;
  /** Del más reciente al más antiguo. */
  listDictionary(): Promise<DictionaryEntry[]>;
  addWord(input: DictionaryInput): Promise<DictionaryResult>;
  editWord(id: string, input: DictionaryInput): Promise<DictionaryResult>;
  /** Cuántas se borraron. */
  removeWords(ids: string[]): Promise<number>;
  starWord(id: string, starred: boolean): Promise<void>;
  /** Vuelve a guardar lo borrado tal cual estaba; cuántas volvieron. */
  restoreWords(entries: DictionaryEntry[]): Promise<number>;
  /** Pide un fichero y dice qué se importaría (preview null si se cancela). */
  chooseDictionaryFile(): Promise<DictionaryImportChoice>;
  /** Cuántas se añadieron. */
  importDictionary(items: DictionaryInput[]): Promise<number>;
  /** Empieza o deja de grabar un atajo (el helper deja de disparar los atajos). */
  recordShortcut(on: boolean): Promise<void>;
  /** Devuelve la función para darse de baja. */
  onShortcutRecording(listener: (r: ShortcutRecording) => void): () => void;
  /** Mide el nivel de un micrófono ('' el del sistema) o deja de medir (null). */
  monitorMicrophone(device: { id: string; label: string } | null): Promise<void>;
  /** Devuelve la función para darse de baja. */
  onMicrophoneLevel(listener: (level: number) => void): () => void;
  /** Vuelve a los ajustes por defecto; el historial y el diccionario no se tocan. */
  resetSettings(): Promise<void>;
  /** Guarda la clave en el llavero. No hay forma de leerla desde aquí. */
  saveApiKey(provider: CloudProvider, key: string): Promise<ApiKeyResult>;
  /** Borra la clave; quien la usara vuelve al motor del equipo. */
  removeApiKey(provider: CloudProvider): Promise<ApiKeyResult>;
  /** Deja que macOS pregunte si Speech puede leer la clave. */
  allowApiKey(provider: CloudProvider): Promise<ApiKeyResult>;
  /** Comprueba la clave con el proveedor. */
  testApiKey(provider: CloudProvider): Promise<ApiKeyResult>;
}
