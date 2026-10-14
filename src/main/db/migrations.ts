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
];
