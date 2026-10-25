import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  cleanInput,
  type DictionaryEntry,
  type DictionaryImportPreview,
  type DictionaryInput,
  type DictionaryResult,
} from '../shared/dictionary';
import { buildSubstitute, type Substitute } from './dictation/substitutions';
import { logger } from './log';

// Diccionario personal en la tabla dictionary. Los términos van como pista al
// motor de transcripción y al formateo; las sustituciones se aplican al texto
// antes de pegarlo. Se lee en cada dictado: la lista es pequeña y así un
// cambio en el Hub vale para el dictado siguiente.

const log = logger('dictionary');

/** Más filas no caben en una pista útil ni en una lista que se lea a mano. */
const MAX_ENTRIES = 5_000;
const MAX_IMPORT_BYTES = 1_000_000;

export class Dictionary {
  private readonly listeners = new Set<() => void>();
  private substituteCache: Substitute | null = null;

  constructor(private readonly db: DatabaseSync) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.substituteCache = null;
    for (const l of this.listeners) l();
  }

  list(): DictionaryEntry[] {
    return this.db
      .prepare('SELECT * FROM dictionary ORDER BY created_at DESC LIMIT ?')
      .all(MAX_ENTRIES)
      .map((r) => ({
        id: String(r.id),
        phrase: String(r.phrase),
        replacement: r.replacement == null ? null : String(r.replacement),
        starred: Number(r.is_starred) === 1,
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      }));
  }

  /** Términos para las pistas: los destacados primero y luego los más recientes. */
  terms(): string[] {
    return this.db
      .prepare('SELECT phrase FROM dictionary WHERE replacement IS NULL ORDER BY is_starred DESC, updated_at DESC')
      .all()
      .map((r) => String(r.phrase));
  }

  /** Lo que se escribe tal cual: términos y reemplazos, para no tocar sus mayúsculas. */
  spellings(): string[] {
    return this.db
      .prepare('SELECT COALESCE(replacement, phrase) AS word FROM dictionary')
      .all()
      .map((r) => String(r.word));
  }

  substitute(text: string): { text: string; count: number } {
    this.substituteCache ??= buildSubstitute(
      this.db
        .prepare('SELECT phrase, replacement FROM dictionary WHERE replacement IS NOT NULL')
        .all()
        .map((r) => ({ phrase: String(r.phrase), replacement: String(r.replacement) })),
    );
    return this.substituteCache(text);
  }

  add(input: DictionaryInput): DictionaryResult {
    const c = cleanInput(input);
    if (!c.ok) return c;
    const taken = this.findByPhrase(c.value.phrase);
    if (taken) return { ok: false, message: `“${taken}” is already in your dictionary.` };
    const now = Date.now();
    this.db
      .prepare('INSERT INTO dictionary (id, phrase, replacement, is_starred, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(randomUUID(), c.value.phrase, c.value.replacement, now, now);
    log.info(`Added a ${c.value.replacement == null ? 'word' : 'replacement'}`);
    this.changed();
    return { ok: true };
  }

  edit(id: string, input: DictionaryInput): DictionaryResult {
    const c = cleanInput(input);
    if (!c.ok) return c;
    const taken = this.findByPhrase(c.value.phrase, id);
    if (taken) return { ok: false, message: `“${taken}” is already in your dictionary.` };
    const r = this.db
      .prepare('UPDATE dictionary SET phrase = ?, replacement = ?, updated_at = ? WHERE id = ?')
      .run(c.value.phrase, c.value.replacement, Date.now(), id);
    if (r.changes === 0) return { ok: false, message: 'This word is no longer in your dictionary.' };
    this.changed();
    return { ok: true };
  }

  remove(ids: string[]): number {
    let n = 0;
    const stmt = this.db.prepare('DELETE FROM dictionary WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const id of ids) n += Number(stmt.run(id).changes);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    log.info(`Removed ${n} ${n === 1 ? 'entry' : 'entries'}`);
    if (n) this.changed();
    return n;
  }

  setStarred(id: string, starred: boolean): void {
    // updated_at no cambia: destacar no la hace «más reciente» en la lista.
    this.db.prepare('UPDATE dictionary SET is_starred = ? WHERE id = ?').run(starred ? 1 : 0, id);
    this.changed();
  }

  /** Lee un fichero de texto o CSV y dice qué se importaría, sin guardar nada. */
  preview(fileName: string, content: Buffer): { ok: true; preview: DictionaryImportPreview } | { ok: false; message: string } {
    if (content.length > MAX_IMPORT_BYTES) return { ok: false, message: 'The file is too large (1 MB at most).' };
    if (content.includes(0)) return { ok: false, message: 'The file is not a text file.' };
    const parsed = parseImport(content.toString('utf8'));
    const existing = new Set(
      this.db
        .prepare('SELECT phrase FROM dictionary')
        .all()
        .map((r) => String(r.phrase).toLowerCase()),
    );
    const items = parsed.items.filter((i) => !existing.has(i.phrase.toLowerCase()));
    const preview = { fileName, items, duplicates: parsed.items.length - items.length, skipped: parsed.skipped };
    if (!items.length && !preview.duplicates) {
      return { ok: false, message: 'No words found in the file. Put one word per line, or “misspelling, correct spelling”.' };
    }
    return { ok: true, preview };
  }

  /** Guarda lo importado. Lo que ya esté (o se repita) se salta. */
  import(items: DictionaryInput[]): number {
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO dictionary (id, phrase, replacement, is_starred, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
    );
    let n = 0;
    this.db.exec('BEGIN');
    try {
      // Cada fila, un milisegundo más vieja: en la lista, la primera del fichero queda arriba.
      items.slice(0, MAX_ENTRIES).forEach((item, i) => {
        const c = cleanInput(item);
        if (c.ok) n += Number(stmt.run(randomUUID(), c.value.phrase, c.value.replacement, now - i, now - i).changes);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    log.info(`Imported ${n} of ${items.length} entries`);
    if (n) this.changed();
    return n;
  }

  /** «Undo» de un borrado: vuelven tal cual estaban (id, fechas y estrella). */
  restore(entries: DictionaryEntry[]): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO dictionary (id, phrase, replacement, is_starred, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const e of entries) {
        const c = cleanInput(e);
        if (c.ok) n += Number(stmt.run(e.id, c.value.phrase, c.value.replacement, e.starred ? 1 : 0, e.createdAt, e.updatedAt).changes);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    log.info(`Restored ${n} of ${entries.length} entries`);
    if (n) this.changed();
    return n;
  }

  private findByPhrase(phrase: string, exceptId?: string): string | null {
    const r = this.db
      .prepare('SELECT phrase FROM dictionary WHERE phrase = ? COLLATE NOCASE AND id != ?')
      .get(phrase, exceptId ?? '');
    return r ? String(r.phrase) : null;
  }
}

/**
 * Una entrada por línea: «palabra», o una sustitución separada por «→», «->»,
 * un tabulador o una coma («misspelling, correct spelling»; las comillas del
 * CSV valen). Se ignoran las líneas vacías, las que empiezan por «#» y una
 * cabecera de CSV en la primera línea.
 */
export function parseImport(text: string): { items: DictionaryInput[]; skipped: number } {
  const items: DictionaryInput[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (i === 0 && /^"?(phrase|word|term|misspelling)s?"?\s*(,|\t|$)/i.test(line)) return;
    const fields = splitLine(line);
    const input = fields && fields.length <= 2 ? { phrase: fields[0] ?? '', replacement: fields[1] || null } : null;
    const c = input ? cleanInput(input) : null;
    if (!c?.ok) {
      skipped++;
      return;
    }
    const k = c.value.phrase.toLowerCase();
    if (seen.has(k)) {
      skipped++;
      return;
    }
    seen.add(k);
    items.push(c.value);
  });
  return { items, skipped };
}

function splitLine(line: string): string[] | null {
  for (const sep of ['→', '->', '\t']) {
    const at = line.indexOf(sep);
    if (at >= 0) return [line.slice(0, at), line.slice(at + sep.length)].map((f) => f.trim());
  }
  return parseCsvLine(line);
}

/** Una línea de CSV; null si las comillas no cierran. */
function parseCsvLine(line: string): string[] | null {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && !field.trim()) {
      quoted = true;
      wasQuoted = true;
      field = '';
    } else if (ch === ',') {
      fields.push(wasQuoted ? field : field.trim());
      field = '';
      wasQuoted = false;
    } else field += ch;
  }
  if (quoted) return null;
  fields.push(wasQuoted ? field : field.trim());
  return fields;
}
