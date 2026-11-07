import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logger } from '../log';
import { MIGRATIONS, type Migration } from './migrations';
import { openDatabase, type OpenedDatabase } from './index';

// Base de datos dañada. Al arrancar se comprueba (PRAGMA quick_check, unos
// milisegundos con un historial normal); si está dañada, o si en marcha
// SQLite avisó de que lo está, se aparta el fichero entero a `damaged/` (no se
// borra nada del usuario), se crea una base nueva y se copian a ella las filas
// que aún se pueden leer de la vieja.

const log = logger('db');

/** Tablas con datos del usuario. `schema_migrations` la rehace la base nueva. */
const USER_TABLES = ['history', 'dictionary'];
/** Tope de la lectura fila a fila cuando la tabla no se puede recorrer entera. */
const MAX_ROWID_SCAN = 200_000;

/** Códigos de SQLite que significan fichero dañado: SQLITE_CORRUPT y SQLITE_NOTADB. */
const DAMAGE_CODES = new Set([11, 26]);

export class DamagedDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DamagedDatabaseError';
  }
}

/** ¿El error dice que el fichero está dañado (y no, por ejemplo, que falta espacio)? */
export function isDamage(err: unknown): boolean {
  if (err instanceof DamagedDatabaseError) return true;
  const e = err as { errcode?: number; message?: string } | null;
  if (typeof e?.errcode === 'number' && DAMAGE_CODES.has(e.errcode & 0xff)) return true;
  return /malformed|not a database|database corrupt/i.test(e?.message ?? '');
}

/** null si está bien; si no, lo que encontró SQLite. */
export function quickCheck(db: DatabaseSync): string | null {
  const rows = db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
  const problems = rows.map((r) => r.quick_check).filter((m) => m !== 'ok');
  return problems.length ? problems.slice(0, 3).join('; ') : null;
}

/**
 * Abre la base y comprueba que no está dañada. Lanza DamagedDatabaseError (o
 * el error de SQLite, que `isDamage` reconoce) si lo está.
 */
export function openChecked(path: string, migrations: Migration[] = MIGRATIONS): OpenedDatabase {
  const opened = openDatabase(path, migrations);
  let problem: string | null;
  try {
    problem = quickCheck(opened.db);
  } catch (err) {
    opened.db.close();
    throw err;
  }
  if (problem) {
    opened.db.close();
    throw new DamagedDatabaseError(problem);
  }
  return opened;
}

export interface RepairResult {
  opened: OpenedDatabase;
  /** Dónde quedó el fichero dañado. */
  backup: string;
  /** Filas leídas de la vieja y copiadas a la nueva, por tabla. */
  recovered: Record<string, number>;
  /** Filas que no se pudieron leer (si se sabe). */
  lost: Record<string, number>;
}

/** Aparta la base dañada, crea una nueva y le copia lo que se pueda leer. */
export function repairDatabase(path: string, migrations: Migration[] = MIGRATIONS): RepairResult {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const dir = join(dirname(path), 'damaged');
  mkdirSync(dir, { recursive: true });
  const backup = join(dir, `${basename(path, '.sqlite')}-${stamp}.sqlite`);
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) renameSync(path + suffix, backup + suffix);
  }
  log.warn(`Damaged database moved to ${backup}`);

  const opened = openDatabase(path, migrations);
  const recovered: Record<string, number> = {};
  const lost: Record<string, number> = {};
  // Se lee de una copia: abrirla aplicaría su WAL y cambiaría la que se guarda.
  const work = join(dir, `.salvage-${stamp}.sqlite`);
  try {
    for (const suffix of ['', '-wal']) {
      if (existsSync(backup + suffix)) copyFileSync(backup + suffix, work + suffix);
    }
    const old = new DatabaseSync(work);
    try {
      for (const table of USER_TABLES) {
        const r = salvageTable(old, opened.db, table);
        recovered[table] = r.copied;
        if (r.unreadable > 0) lost[table] = r.unreadable;
      }
    } finally {
      old.close();
    }
  } catch (err) {
    log.error(`Could not read anything from the damaged database: ${(err as Error).message}`);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(work + suffix, { force: true });
  }
  log.warn(`Database repaired: recovered ${JSON.stringify(recovered)}, unreadable ${JSON.stringify(lost)}`);
  return { opened, backup, recovered, lost };
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

/** Copia las filas legibles de `table`. Primero de una pasada; si falla, fila a fila. */
function salvageTable(from: DatabaseSync, to: DatabaseSync, table: string): { copied: number; unreadable: number } {
  let have: string[];
  try {
    have = columns(from, table);
  } catch (err) {
    log.warn(`Salvage ${table}: cannot read its columns (${(err as Error).message})`);
    return { copied: 0, unreadable: 0 };
  }
  const cols = columns(to, table).filter((c) => have.includes(c));
  if (!cols.length) return { copied: 0, unreadable: 0 };
  const list = cols.map((c) => `"${c}"`).join(', ');
  const insert = to.prepare(`INSERT OR IGNORE INTO ${table} (${list}) VALUES (${cols.map(() => '?').join(', ')})`);
  const put = (row: Record<string, unknown>): boolean => {
    try {
      return Number(insert.run(...cols.map((c) => row[c] as never)).changes) > 0;
    } catch {
      return false;
    }
  };

  to.exec('BEGIN');
  try {
    let copied = 0;
    try {
      for (const row of from.prepare(`SELECT ${list} FROM ${table}`).iterate()) if (put(row as Record<string, unknown>)) copied++;
      to.exec('COMMIT');
      return { copied, unreadable: 0 };
    } catch (err) {
      log.warn(`Salvage ${table}: full scan stopped after ${copied} rows (${(err as Error).message}); trying row by row`);
    }
    // Fila a fila por rowid: una página dañada solo se lleva sus filas.
    let max = 0;
    try {
      max = Number((from.prepare(`SELECT max(rowid) AS m FROM ${table}`).get() as { m: number | null }).m ?? 0);
    } catch {
      max = MAX_ROWID_SCAN;
    }
    // Lo copiado en la primera pasada ya está: INSERT OR IGNORE no lo cuenta dos veces.
    const one = from.prepare(`SELECT ${list} FROM ${table} WHERE rowid = ?`);
    let unreadable = 0;
    for (let id = 1; id <= Math.min(max, MAX_ROWID_SCAN); id++) {
      try {
        const row = one.get(id) as Record<string, unknown> | undefined;
        if (row && put(row)) copied++;
      } catch {
        unreadable++;
      }
    }
    to.exec('COMMIT');
    return { copied, unreadable };
  } catch (err) {
    to.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Envuelve la conexión para enterarse de que el fichero está dañado aunque el
 * error ocurra en marcha, en cualquier consulta. El error se sigue lanzando.
 */
export function watchForDamage(db: DatabaseSync, onDamage: (err: Error) => void): DatabaseSync {
  let reported = false;
  const check = (err: unknown): unknown => {
    if (!reported && isDamage(err)) {
      reported = true;
      onDamage(err as Error);
    }
    return err;
  };
  const guard = <T extends object>(target: T, wrapResult?: (v: unknown) => unknown): T =>
    new Proxy(target, {
      get(t, key) {
        const v = Reflect.get(t, key, t) as unknown;
        if (typeof v !== 'function') return v;
        return (...args: unknown[]) => {
          try {
            const out = (v as (...a: unknown[]) => unknown).apply(t, args);
            return wrapResult ? wrapResult(out) : out;
          } catch (err) {
            throw check(err);
          }
        };
      },
    });
  // Las sentencias preparadas también: el error suele llegar al ejecutarlas.
  const plain = guard(db);
  const preparing = guard(db, (v) => (v && typeof v === 'object' ? guard(v as object) : v));
  return new Proxy(db, {
    get(_t, key) {
      return Reflect.get(key === 'prepare' ? preparing : plain, key);
    },
  });
}
