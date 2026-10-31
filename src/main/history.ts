import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { HistoryEntry, HistoryPage, HistoryQuery, HistoryStats, HistoryStatus } from '../shared/history';
import type { PasteResult } from '../shared/state';
import { logger } from './log';

// Historial de dictados en la tabla history. El audio va en ficheros WAV en
// `recordings/`; la fila guarda su ruta. Pasados 14 días se borra el fichero y
// audio_path queda a NULL: el texto se conserva.

const log = logger('history');

const AUDIO_RETENTION_MS = 14 * 24 * 60 * 60_000;
const MAX_PAGE = 500;

export interface NewHistoryEntry {
  id: string;
  createdAt: number;
  status: HistoryStatus;
  durationMs: number;
  audioPath: string | null;
  language: string | null;
}

export interface HistoryUpdate {
  status?: HistoryStatus;
  asrText?: string | null;
  language?: string | null;
  engine?: string | null;
  model?: string | null;
  transcriptionMs?: number | null;
  pastedText?: string | null;
  appName?: string | null;
  appBundleId?: string | null;
  pasteResult?: PasteResult | null;
  pasteMs?: number | null;
  formattedText?: string | null;
  formatResult?: string | null;
  formatProvider?: string | null;
  formatModel?: string | null;
  formatMs?: number | null;
  formatError?: string | null;
  error?: string | null;
  showFormatted?: boolean;
  flagged?: boolean;
}

const COLUMNS: Record<keyof HistoryUpdate, string> = {
  status: 'status',
  asrText: 'asr_text',
  language: 'language',
  engine: 'engine',
  model: 'model',
  transcriptionMs: 'transcription_ms',
  pastedText: 'pasted_text',
  appName: 'app_name',
  appBundleId: 'app_bundle_id',
  pasteResult: 'paste_result',
  pasteMs: 'paste_ms',
  formattedText: 'formatted_text',
  formatResult: 'format_result',
  formatProvider: 'format_provider',
  formatModel: 'format_model',
  formatMs: 'format_ms',
  formatError: 'format_error',
  error: 'error',
  showFormatted: 'show_formatted',
  flagged: 'flagged',
};

export class History {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly recordingsDir: string,
  ) {}

  insert(e: NewHistoryEntry): void {
    this.db
      .prepare(
        `INSERT INTO history (id, created_at, status, duration_ms, audio_path, language)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.createdAt, e.status, e.durationMs, e.audioPath, e.language);
    this.changed();
  }

  update(id: string, u: HistoryUpdate): void {
    const keys = (Object.keys(u) as (keyof HistoryUpdate)[]).filter((k) => u[k] !== undefined);
    if (!keys.length) return;
    const sets = keys.map((k) => `${COLUMNS[k]} = ?`).join(', ');
    const values = keys.map((k) => {
      const v = u[k];
      return (typeof v === 'boolean' ? (v ? 1 : 0) : v) as SQLInputValue;
    });
    this.db.prepare(`UPDATE history SET ${sets} WHERE id = ?`).run(...values, id);
    this.changed();
  }

  audioPath(id: string): string | null {
    const row = this.db.prepare('SELECT audio_path FROM history WHERE id = ?').get(id);
    return row?.audio_path == null ? null : String(row.audio_path);
  }

  /** El texto del último dictado que tenía algo que pegar. */
  lastText(): string | null {
    const row = this.db
      .prepare(
        `SELECT COALESCE(pasted_text, asr_text) AS text FROM history
         WHERE status = 'done' AND COALESCE(pasted_text, asr_text, '') <> ''
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    return row?.text == null ? null : String(row.text);
  }

  /** Los dictados del más reciente al más antiguo, opcionalmente filtrados por texto. */
  list(q: HistoryQuery): HistoryPage {
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(q.limit) || 50));
    const search = q.search?.trim();
    const where = search
      ? `WHERE asr_text LIKE ?1 ESCAPE '\\' OR formatted_text LIKE ?1 ESCAPE '\\'`
      : '';
    const params: SQLInputValue[] = search ? [`%${search.replace(/[\\%_]/g, '\\$&')}%`] : [];
    const rows = this.db
      .prepare(`SELECT ${SELECT} FROM history ${where} ORDER BY created_at DESC LIMIT ${limit + 1}`)
      .all(...params);
    return { entries: rows.slice(0, limit).map(toEntry), more: rows.length > limit };
  }

  get(id: string): HistoryEntry | null {
    const row = this.db.prepare(`SELECT ${SELECT} FROM history WHERE id = ?`).get(id);
    return row ? toEntry(row) : null;
  }

  /** Borra la fila y su audio. */
  delete(id: string): boolean {
    const file = this.audioPath(id);
    const r = this.db.prepare('DELETE FROM history WHERE id = ?').run(id);
    if (file) remove(file);
    const deleted = Number(r.changes) > 0;
    if (deleted) this.changed();
    return deleted;
  }

  /**
   * Borra los dictados (y su audio) creados antes de `cutoff` que ya
   * terminaron; los que están en curso se quedan. Devuelve cuántos borró.
   */
  deleteBefore(cutoff: number): number {
    const rows = this.db
      .prepare(`SELECT id, audio_path FROM history WHERE created_at < ? AND status NOT IN ('recording', 'processing')`)
      .all(cutoff);
    const del = this.db.prepare('DELETE FROM history WHERE id = ?');
    for (const row of rows) {
      del.run(String(row.id));
      if (row.audio_path != null) remove(String(row.audio_path));
    }
    if (rows.length) this.changed();
    return rows.length;
  }

  /** Palabras, ritmo y racha, sobre el texto que enseña cada fila. */
  stats(now = Date.now()): HistoryStats {
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN show_formatted = 1 AND formatted_text IS NOT NULL THEN formatted_text ELSE asr_text END AS text,
                duration_ms, created_at
         FROM history WHERE status = 'done'`,
      )
      .all();
    let totalWords = 0;
    let spokenMs = 0;
    const days = new Set<string>();
    for (const r of rows) {
      const words = r.text == null ? 0 : (String(r.text).match(/\S+/g)?.length ?? 0);
      if (!words) continue;
      totalWords += words;
      spokenMs += Number(r.duration_ms ?? 0);
      days.add(dayKey(Number(r.created_at)));
    }
    // La racha sigue viva si hoy aún no se ha dictado pero ayer sí.
    const day = new Date(now);
    if (!days.has(dayKey(day.getTime()))) day.setDate(day.getDate() - 1);
    let streakDays = 0;
    while (days.has(dayKey(day.getTime()))) {
      streakDays++;
      day.setDate(day.getDate() - 1);
    }
    const wpm = spokenMs >= 10_000 ? Math.round(totalWords / (spokenMs / 60_000)) : null;
    return { totalWords, wpm, streakDays };
  }

  /** Avisa de cada cambio (para que el Hub vuelva a leer la lista). */
  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  /**
   * Al arrancar: los dictados que quedaron a medias (la app se cerró mientras
   * grababa o transcribía) pasan a «failed».
   */
  markInterrupted(): void {
    const interrupted = this.db
      .prepare(`UPDATE history SET status = 'failed', error = 'interrupted: Speech quit before it finished'
                WHERE status IN ('recording', 'processing')`)
      .run();
    if (Number(interrupted.changes) > 0) {
      log.info(`Marked ${interrupted.changes} interrupted dictations as failed`);
      this.changed();
    }
  }

  /**
   * Borra el audio con más de 14 días, tenga fila o no. Corre al arrancar y
   * cada día a las 12:00.
   */
  purgeOldAudio(now = Date.now()): void {
    const cutoff = now - AUDIO_RETENTION_MS;
    const old = this.db
      .prepare('SELECT id, audio_path FROM history WHERE audio_path IS NOT NULL AND created_at < ?')
      .all(cutoff);
    const clear = this.db.prepare('UPDATE history SET audio_path = NULL WHERE id = ?');
    for (const row of old) {
      remove(String(row.audio_path));
      clear.run(String(row.id));
    }

    // Ficheros sin fila (de antes de existir el historial, o de un cierre a mitad).
    let orphans = 0;
    try {
      for (const f of readdirSync(this.recordingsDir)) {
        if (!f.endsWith('.wav')) continue;
        const path = join(this.recordingsDir, f);
        if (statSync(path).mtimeMs < cutoff && remove(path)) orphans++;
      }
    } catch (err) {
      log.warn(`Could not scan recordings: ${(err as Error).message}`);
    }
    log.info(`Audio cleanup: deleted ${old.length} dictations' audio and ${orphans} other files older than 14 days`);
    if (old.length) this.changed();
  }
}

const SELECT = `id, created_at, status, duration_ms, audio_path, asr_text, language, engine, model,
  transcription_ms, pasted_text, app_name, paste_result, paste_ms, error,
  formatted_text, format_result, format_model, format_ms, format_error, show_formatted, flagged`;

type Row = Record<string, SQLOutputValue>;

function toEntry(r: Row): HistoryEntry {
  const str = (v: SQLOutputValue): string | null => (v == null ? null : String(v));
  const num = (v: SQLOutputValue): number | null => (v == null ? null : Number(v));
  return {
    id: String(r.id),
    createdAt: Number(r.created_at),
    status: String(r.status) as HistoryStatus,
    durationMs: num(r.duration_ms),
    hasAudio: r.audio_path != null,
    text: str(r.asr_text),
    language: str(r.language),
    engine: str(r.engine),
    model: str(r.model),
    transcriptionMs: num(r.transcription_ms),
    pastedText: str(r.pasted_text),
    appName: str(r.app_name),
    pasteResult: str(r.paste_result) as PasteResult | null,
    pasteMs: num(r.paste_ms),
    error: str(r.error),
    formattedText: str(r.formatted_text),
    formatResult: str(r.format_result),
    formatModel: str(r.format_model),
    formatMs: num(r.format_ms),
    formatError: str(r.format_error),
    showFormatted: Number(r.show_formatted) === 1,
    flagged: Number(r.flagged) === 1,
  };
}

/** Fecha local, para agrupar por día. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function remove(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`Could not delete ${path}: ${(err as Error).message}`);
    return false;
  }
}
