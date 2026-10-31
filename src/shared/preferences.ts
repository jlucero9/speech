// Preferencias del usuario, guardadas en preferences.json. Cada paso añade las
// suyas; un fichero antiguo se completa con los valores por defecto al leerlo.

import { isBarEdge, type BarEdge } from './bar';
import { isFormattingProvider, type FormattingProvider } from './formatting';
import { DEFAULT_SHORTCUTS, isShortcutList, type ShortcutBinding } from './shortcuts';
import { isDictationLanguage } from './transcription';

export interface Preferences {
  /** Sonidos de inicio y fin de dictado y de los avisos de la barra. */
  enableSounds: boolean;
  /** Formateo del texto dictado (paso 8). */
  smartFormatting: boolean;
  /** Código de idioma para la transcripción (ISO 639-1). Sin guardar, el del sistema. */
  dictationLanguage: string;
  /** Quién formatea: Ollama en el equipo o, con clave propia, Groq o Gemini. */
  formattingProvider: FormattingProvider;
  /** Borde de la pantalla donde se ancla la barra. */
  barEdge: BarEdge;
  /** Con false, la barra solo aparece mientras se dicta o hay un aviso. */
  showBar: boolean;
  /** Hora (ms) hasta la que la barra en reposo está oculta; 0 si no lo está. */
  barHiddenUntil: number;
  /** Atajos de teclado, varios por acción. */
  shortcuts: ShortcutBinding[];
  /**
   * Micrófono elegido: su id y su nombre (el id puede cambiar al volver a
   * conectarlo; el nombre sirve para reconocerlo). Vacío: el del sistema.
   */
  microphoneId: string;
  microphoneLabel: string;
  /** Silenciar la salida de audio del equipo mientras se dicta. */
  muteWhileDictating: boolean;
  /** Abrir la app al iniciar sesión (lo guarda macOS; esto es su reflejo). */
  launchAtLogin: boolean;
  /** Icono en el Dock. */
  showInDock: boolean;
  /** Leer el texto que rodea al cursor en la app donde se dicta. */
  contextAwareness: boolean;
  /** Qué se guarda del historial: todo, solo 24 horas o nada. */
  historyStorage: HistoryStorage;
}

export type HistoryStorage = 'store' | 'autodelete' | 'never';

export function isHistoryStorage(value: unknown): value is HistoryStorage {
  return value === 'store' || value === 'autodelete' || value === 'never';
}

export const DEFAULT_PREFERENCES: Preferences = {
  enableSounds: true,
  smartFormatting: true,
  dictationLanguage: 'en',
  formattingProvider: 'ollama',
  barEdge: 'bottom',
  showBar: true,
  barHiddenUntil: 0,
  shortcuts: DEFAULT_SHORTCUTS,
  microphoneId: '',
  microphoneLabel: '',
  muteWhileDictating: false,
  launchAtLogin: false,
  showInDock: false,
  contextAwareness: true,
  historyStorage: 'store',
};

/** Validación más estricta que el tipo, para las que tienen valores cerrados. */
const VALIDATORS: { [K in keyof Preferences]?: (value: unknown) => boolean } = {
  dictationLanguage: isDictationLanguage,
  formattingProvider: isFormattingProvider,
  barEdge: isBarEdge,
  barHiddenUntil: (v) => Number.isFinite(v) && (v as number) >= 0,
  shortcuts: isShortcutList,
  microphoneId: (v) => (v as string).length <= 512,
  microphoneLabel: (v) => (v as string).length <= 512,
  historyStorage: isHistoryStorage,
};

/** Comprueba que el valor tiene el mismo tipo que el de por defecto (y, si lo hay, pasa su validación). */
export function isValidPreference<K extends keyof Preferences>(key: K, value: unknown): value is Preferences[K] {
  if (!(key in DEFAULT_PREFERENCES) || typeof value !== typeof DEFAULT_PREFERENCES[key]) return false;
  return VALIDATORS[key]?.(value) ?? true;
}
