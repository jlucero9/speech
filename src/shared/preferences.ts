// Preferencias del usuario, guardadas en preferences.json. Cada paso añade las
// suyas; un fichero antiguo se completa con los valores por defecto al leerlo.

export interface Preferences {
  /** Sonidos de inicio y fin de dictado (paso 10). */
  enableSounds: boolean;
  /** Formateo del texto dictado (paso 8). */
  smartFormatting: boolean;
  /** Código de idioma para la transcripción, o 'auto' (paso 6). */
  dictationLanguage: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  enableSounds: true,
  smartFormatting: true,
  dictationLanguage: 'auto',
};

/** Comprueba que el valor tiene el mismo tipo que el de por defecto. */
export function isValidPreference<K extends keyof Preferences>(key: K, value: unknown): value is Preferences[K] {
  return key in DEFAULT_PREFERENCES && typeof value === typeof DEFAULT_PREFERENCES[key];
}
