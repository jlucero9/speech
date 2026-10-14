import { DatabaseSync } from 'node:sqlite';
import { logger } from '../log';
import { MIGRATIONS, type Migration } from './migrations';

// SQLite con el módulo integrado de Node (node:sqlite): sin módulos nativos que
// recompilar para Electron. Una sola conexión, en main.

const log = logger('db');

export interface OpenedDatabase {
  db: DatabaseSync;
  schemaVersion: number;
  appliedThisLaunch: number;
}

export function openDatabase(path: string, migrations: Migration[] = MIGRATIONS): OpenedDatabase {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  try {
    const applied = migrate(db, migrations);
    const schemaVersion = migrations.length ? migrations[migrations.length - 1].id : 0;
    return { db, schemaVersion, appliedThisLaunch: applied };
  } catch (err) {
    db.close();
    throw err;
  }
}

function migrate(db: DatabaseSync, migrations: Migration[]): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  const done = new Map<number, string>();
  for (const row of db.prepare('SELECT id, name FROM schema_migrations').all()) {
    done.set(Number(row.id), String(row.name));
  }

  for (const [id, name] of done) {
    const known = migrations.find((m) => m.id === id);
    if (!known) throw new Error(`Database has migration ${id} (${name}) that this version does not know`);
    if (known.name !== name) throw new Error(`Migration ${id} is "${name}" in the database but "${known.name}" in code`);
  }

  let applied = 0;
  const insert = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    // Cada migración en su transacción: o se aplica entera o no se aplica.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      insert.run(m.id, m.name, Date.now());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.id} (${m.name}) failed: ${(err as Error).message}`);
    }
    log.info(`Applied migration ${m.id} ${m.name}`);
    applied++;
  }
  log.info(`Migrations: ${applied} applied, ${done.size} already applied`);
  return applied;
}
