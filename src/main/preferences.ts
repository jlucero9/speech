import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DEFAULT_PREFERENCES, isValidPreference, type Preferences } from '../shared/preferences';
import { logger } from './log';

// preferences.json en el directorio de datos. Se escribe entero en un fichero
// temporal y se renombra, para que un cierre a mitad no lo deje cortado.

const log = logger('prefs');
const FILE_VERSION = 1;

export function loadPreferences(path: string): Preferences {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    log.info('No preferences file yet, using defaults');
    return { ...DEFAULT_PREFERENCES };
  }
  try {
    const parsed = JSON.parse(raw) as { prefs?: Record<string, unknown> };
    const prefs: Preferences = { ...DEFAULT_PREFERENCES };
    for (const [key, value] of Object.entries(parsed.prefs ?? {})) {
      if (isValidPreference(key as keyof Preferences, value)) {
        (prefs as unknown as Record<string, unknown>)[key] = value;
      } else {
        log.warn(`Ignoring unknown or invalid preference "${key}"`);
      }
    }
    return prefs;
  } catch (err) {
    // Fichero dañado: se aparta para poder revisarlo y se sigue con valores por defecto.
    const aside = `${path}.corrupt-${Date.now()}`;
    log.error(`Preferences file is not valid JSON, moved to ${aside}`, err);
    try {
      renameSync(path, aside);
    } catch {
      // Si no se puede apartar, se sobrescribirá en el próximo guardado.
    }
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(path: string, prefs: Preferences): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, prefs }, null, 2) + '\n');
  renameSync(tmp, path);
}
