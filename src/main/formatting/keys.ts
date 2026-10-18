import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Claves de los proveedores en la nube, mientras no exista la pantalla de
// claves: un fichero KEY=valor fuera del proyecto (la app abierta con `open`
// no puede leer el Escritorio) y, si falta, la variable de entorno del mismo
// nombre. Se lee en cada uso, así que editarlo no exige reiniciar.

export const KEYS_FILE = join(homedir(), '.config', 'speech', 'keys.env');

export type KeyName = 'GROQ_API_KEY' | 'GEMINI_API_KEY';

export function readKey(name: KeyName): string | null {
  try {
    for (const line of readFileSync(KEYS_FILE, 'utf8').split('\n')) {
      const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || m[1] !== name) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (value) return value;
    }
  } catch {
    // Sin fichero: se mira el entorno.
  }
  return process.env[name] || null;
}
