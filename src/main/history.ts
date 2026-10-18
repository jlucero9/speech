import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { PasteResult } from '../shared/state';
import type { HistoryEntry, HistoryStatus } from '../shared/transcription';
import { logger } from './log';

// Historial de dictados en la tabla history. El audio va en ficheros WAV en
// `recordings/`; la fila guarda su ruta. Pasados 14 días se borra el fichero y
// audio_path queda a NULL: el texto se conserva.

const log = logger('history');

const AUDIO_RETENTION_MS = 14 * 24 * 60 * 60_000;

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
};

export class History {
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
  }

  update(id: string, u: HistoryUpdate): void {
    const keys = (Object.keys(u) as (keyof HistoryUpdate)[]).filter((k) => u[k] !== undefined);
    if (!keys.length) return;
    const sets = keys.map((k) => `${COLUMNS[k]} = ?`).join(', ');
    const values = keys.map((k) => u[k] as SQLInputValue);
    this.db.prepare(`UPDATE history SET ${sets} WHERE id = ?`).run(...values, id);
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

  recent(limit: number): HistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, created_at, status, duration_ms, audio_path, asr_text, language, engine, model,
                transcription_ms, pasted_text, app_name, paste_result, paste_ms, error,
                formatted_text, format_result, format_model, format_ms, format_error
         FROM history ORDER BY created_at DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(200, Math.floor(limit))));
    return rows.map((r) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      status: String(r.status) as HistoryStatus,
      durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
      audioPath: r.audio_path == null ? null : String(r.audio_path),
      text: r.asr_text == null ? null : String(r.asr_text),
      language: r.language == null ? null : String(r.language),
      engine: r.engine == null ? null : String(r.engine),
      model: r.model == null ? null : String(r.model),
      transcriptionMs: r.transcription_ms == null ? null : Number(r.transcription_ms),
      pastedText: r.pasted_text == null ? null : String(r.pasted_text),
      appName: r.app_name == null ? null : String(r.app_name),
      pasteResult: r.paste_result == null ? null : (String(r.paste_result) as PasteResult),
      pasteMs: r.paste_ms == null ? null : Number(r.paste_ms),
      error: r.error == null ? null : String(r.error),
      formattedText: r.formatted_text == null ? null : String(r.formatted_text),
      formatResult: r.format_result == null ? null : String(r.format_result),
      formatModel: r.format_model == null ? null : String(r.format_model),
      formatMs: r.format_ms == null ? null : Number(r.format_ms),
      formatError: r.format_error == null ? null : String(r.format_error),
    }));
  }

  /**
   * Al arrancar: los dictados que quedaron a medias (la app se cerró mientras
   * grababa o transcribía) pasan a «failed», y se borra el audio con más de
   * 14 días, tenga fila o no.
   */
  tidy(now = Date.now()): void {
    const interrupted = this.db
      .prepare(`UPDATE history SET status = 'failed', error = 'interrupted: Speech quit before it finished'
                WHERE status IN ('recording', 'processing')`)
      .run();
    if (Number(interrupted.changes) > 0) log.info(`Marked ${interrupted.changes} interrupted dictations as failed`);

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
    if (old.length || orphans) log.info(`Deleted audio older than 14 days: ${old.length} dictations, ${orphans} other files`);
  }
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
