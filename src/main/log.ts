import { app } from 'electron';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Registro sencillo: consola y ~/Library/Logs/Speech/main.log.
// Al arrancar, si el fichero pasa de 5 MB se aparta como main.old.log.

const MAX_BYTES = 5 * 1024 * 1024;
let file: string | null = null;

function init(): string | null {
  if (file) return file;
  try {
    const dir = app.getPath('logs');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'main.log');
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, join(dir, 'main.old.log'));
    } catch {
      // No existe todavía.
    }
    file = path;
  } catch {
    file = null;
  }
  return file;
}

function write(level: string, scope: string, args: unknown[]): void {
  const text = args
    .map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `${new Date().toISOString()} ${level} [${scope}] ${text}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  const path = init();
  if (path) {
    try {
      appendFileSync(path, line + '\n');
    } catch {
      // El registro nunca debe tumbar la app.
    }
  }
}

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export function logger(scope: string): Logger {
  return {
    info: (...a) => write('INFO', scope, a),
    warn: (...a) => write('WARN', scope, a),
    error: (...a) => write('ERROR', scope, a),
  };
}
