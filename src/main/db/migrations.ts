// Migraciones de la base de datos, en orden. Una migración ya publicada no se
// edita ni se renumera: los cambios van en una nueva. El ejecutor (index.ts)
// comprueba que los nombres de las ya aplicadas no hayan cambiado.

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'create-history',
    // Un registro por dictado. Se crea al empezar a dictar y se completa al
    // terminar de grabar (audio) y al tener resultado (textos).
    sql: `
      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('recording', 'processing', 'done', 'cancelled', 'failed')),
        duration_ms INTEGER,
        -- WAV en el directorio de audio; el fichero se borra a los 14 días y
        -- entonces audio_path pasa a NULL.
        audio_path TEXT,
        asr_text TEXT,
        formatted_text TEXT,
        pasted_text TEXT,
        -- 1: el historial muestra el texto formateado; 0: el transcrito.
        show_formatted INTEGER NOT NULL DEFAULT 1,
        language TEXT,
        app_name TEXT,
        app_bundle_id TEXT,
        error TEXT
      );
      CREATE INDEX history_created_at ON history (created_at DESC);
    `,
  },
  {
    id: 2,
    name: 'create-dictionary',
    // replacement NULL: palabra que el motor debe reconocer.
    // replacement con texto: sustitución «cuando oigas phrase, escribe replacement».
    sql: `
      CREATE TABLE dictionary (
        id TEXT PRIMARY KEY,
        phrase TEXT NOT NULL,
        replacement TEXT,
        is_starred INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX dictionary_phrase ON dictionary (phrase COLLATE NOCASE);
    `,
  },
  {
    id: 3,
    name: 'history-transcription-info',
    // Con qué se transcribió cada dictado y cuánto tardó, para comparar motores
    // y modelos. engine: 'local' (y, más adelante, los de la nube); model: el
    // identificador del modelo; transcription_ms: desde que acabó la grabación
    // hasta tener el texto.
    sql: `
      ALTER TABLE history ADD COLUMN engine TEXT;
      ALTER TABLE history ADD COLUMN model TEXT;
      ALTER TABLE history ADD COLUMN transcription_ms INTEGER;
    `,
  },
  {
    id: 4,
    name: 'history-paste-result',
    // Cómo acabó el pegado de cada dictado (pasted_text, app_name y
    // app_bundle_id ya existían). paste_result: 'pasted', 'pasted_unverified',
    // 'unconfirmed', 'not_requested', 'target_gone', 'focus_failed', 'failed'
    // o 'empty'; NULL si no se intentó. paste_ms: desde
    // soltar la tecla hasta que la app pidió el texto.
    sql: `
      ALTER TABLE history ADD COLUMN paste_result TEXT;
      ALTER TABLE history ADD COLUMN paste_ms INTEGER;
    `,
  },
  {
    id: 5,
    name: 'history-formatting',
    // Cómo se formateó cada dictado (formatted_text ya existía).
    // format_result: 'formatted'; 'off' si el formateo estaba apagado; o, si se
    // pegó la transcripción sin formatear, el motivo: 'raw_timeout',
    // 'raw_not_ready', 'raw_rejected', 'raw_failed'… format_error: el detalle
    // de ese fallo. format_provider: 'ollama', 'groq' o 'gemini'; format_model:
    // el modelo; format_ms: lo que tardó.
    sql: `
      ALTER TABLE history ADD COLUMN format_result TEXT;
      ALTER TABLE history ADD COLUMN format_provider TEXT;
      ALTER TABLE history ADD COLUMN format_model TEXT;
      ALTER TABLE history ADD COLUMN format_ms INTEGER;
      ALTER TABLE history ADD COLUMN format_error TEXT;
    `,
  },
  {
    id: 6,
    name: 'history-flagged',
    // Marca que el usuario pone a un dictado desde el historial (la bandera de
    // la fila), para encontrarlo después.
    sql: `
      ALTER TABLE history ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;
    `,
  },
];
