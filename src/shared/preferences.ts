// Preferencias del usuario, guardadas en preferences.json. Cada paso añade las
// suyas; un fichero antiguo se completa con los valores por defecto al leerlo.

import { isFormattingProvider, type FormattingProvider } from './formatting';
import { isDictationLanguage } from './transcription';

export interface Preferences {
  /** Sonidos de inicio y fin de dictado (paso 10). */
  enableSounds: boolean;
  /** Formateo del texto dictado (paso 8). */
  smartFormatting: boolean;
  /** Código de idioma para la transcripción (ISO 639-1). Sin guardar, el del sistema. */
  dictationLanguage: string;
  /** Quién formatea: Ollama en el equipo o, con clave propia, Groq o Gemini. */
  formattingProvider: FormattingProvider;
}

export const DEFAULT_PREFERENCES: Preferences = {
  enableSounds: true,
  smartFormatting: true,
  dictationLanguage: 'en',
  formattingProvider: 'ollama',
};

/** Validación más estricta que el tipo, para las que tienen valores cerrados. */
const VALIDATORS: { [K in keyof Preferences]?: (value: unknown) => boolean } = {
  dictationLanguage: isDictationLanguage,
  formattingProvider: isFormattingProvider,
};

/** Comprueba que el valor tiene el mismo tipo que el de por defecto (y, si lo hay, pasa su validación). */
export function isValidPreference<K extends keyof Preferences>(key: K, value: unknown): value is Preferences[K] {
  if (!(key in DEFAULT_PREFERENCES) || typeof value !== typeof DEFAULT_PREFERENCES[key]) return false;
  return VALIDATORS[key]?.(value) ?? true;
}
