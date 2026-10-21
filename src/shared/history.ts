// Historial de dictados tal como lo ve la interfaz, y las acciones del Hub
// sobre él.

import type { PasteResult } from './state';

export type HistoryStatus = 'recording' | 'processing' | 'done' | 'cancelled' | 'failed';

/** Una fila del historial. */
export interface HistoryEntry {
  id: string;
  createdAt: number;
  status: HistoryStatus;
  durationMs: number | null;
  /** El audio sigue guardado (se borra a los 14 días). */
  hasAudio: boolean;
  /** Transcripción tal cual. */
  text: string | null;
  language: string | null;
  engine: string | null;
  model: string | null;
  transcriptionMs: number | null;
  /** Texto que se envió a pegar. */
  pastedText: string | null;
  /** App en la que se pegó (o se intentó). */
  appName: string | null;
  pasteResult: PasteResult | null;
  /** Desde soltar la tecla hasta que la app pidió el texto. */
  pasteMs: number | null;
  error: string | null;
  /** Texto formateado; null si no se formateó. */
  formattedText: string | null;
  /** 'formatted', 'off' o 'raw_<motivo>' (se pegó la transcripción tal cual). */
  formatResult: string | null;
  formatModel: string | null;
  formatMs: number | null;
  formatError: string | null;
  /** true: se muestra el texto formateado; false: el usuario deshizo la edición. */
  showFormatted: boolean;
  flagged: boolean;
}

export interface HistoryQuery {
  limit: number;
  /** Texto a buscar en la transcripción y en el texto formateado. */
  search?: string;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** Hay más filas que las pedidas. */
  more: boolean;
}

export interface HistoryStats {
  totalWords: number;
  /** Palabras por minuto de audio dictado; null sin datos. */
  wpm: number | null;
  /** Días seguidos con algún dictado, hasta hoy o ayer. */
  streakDays: number;
}

/** Resultado de una acción del Hub: si falla, el texto del aviso. */
export type HistoryActionResult = { ok: true } | { ok: false; message: string };

/** El texto que la fila enseña: el formateado, salvo que se haya deshecho. */
export function shownText(e: HistoryEntry): string | null {
  return e.showFormatted && e.formattedText ? e.formattedText : e.text;
}

/** La fila tiene una edición de IA que se puede deshacer o rehacer. */
export function hasAiEdit(e: HistoryEntry): boolean {
  return !!e.formattedText && !!e.text && e.formattedText.trim() !== e.text.trim();
}
