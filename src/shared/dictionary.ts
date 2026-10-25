// Diccionario personal tal como lo ve la interfaz, y las acciones del Hub
// sobre él.
//
// Una fila es un término («escríbelo así») si no tiene sustitución, o una
// sustitución («cuando oigas phrase, escribe replacement») si la tiene.

export interface DictionaryEntry {
  id: string;
  phrase: string;
  /** null: término; con texto: sustitución. */
  replacement: string | null;
  /** Destacado: va siempre el primero en las pistas al motor y al formateo. */
  starred: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DictionaryInput {
  phrase: string;
  replacement: string | null;
}

export type DictionaryResult = { ok: true } | { ok: false; message: string };

/** Lo leído de un fichero antes de importarlo. */
export interface DictionaryImportPreview {
  fileName: string;
  /** Filas nuevas, sin las que ya están en el diccionario ni las repetidas. */
  items: DictionaryInput[];
  /** Ya estaban en el diccionario (no se tocan). */
  duplicates: number;
  /** Líneas que no se pudieron leer o no caben. */
  skipped: number;
}

export type DictionaryImportChoice =
  | { ok: true; preview: DictionaryImportPreview }
  | { ok: true; preview: null }
  | { ok: false; message: string };

export const MAX_PHRASE_CHARS = 100;
export const MAX_REPLACEMENT_CHARS = 1000;

/**
 * Limpia y valida lo que se va a guardar. Los espacios de dentro se juntan:
 * la frase se busca palabra por palabra.
 */
export function cleanInput(input: DictionaryInput): { ok: true; value: DictionaryInput } | { ok: false; message: string } {
  const phrase = input.phrase.replace(/\s+/g, ' ').trim();
  const replacement = input.replacement == null ? null : input.replacement.trim();
  if (!phrase) return { ok: false, message: 'Enter a word or phrase.' };
  if (phrase.length > MAX_PHRASE_CHARS) return { ok: false, message: `Keep it under ${MAX_PHRASE_CHARS} characters.` };
  if (replacement != null) {
    if (!replacement) return { ok: false, message: 'Enter the correct spelling.' };
    if (replacement.length > MAX_REPLACEMENT_CHARS) {
      return { ok: false, message: `Keep the correct spelling under ${MAX_REPLACEMENT_CHARS} characters.` };
    }
    if (replacement === phrase) return { ok: false, message: 'The correct spelling is the same as the misspelling.' };
  }
  return { ok: true, value: { phrase, replacement } };
}
