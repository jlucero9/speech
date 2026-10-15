// Contrato con SpeechTranscriber (transcriber/main.cpp): un objeto JSON por
// línea en cada sentido. Las órdenes llevan un id y la respuesta lo repite.

export const TRANSCRIBER_PROTOCOL = 1;

export type TranscriberCommand =
  | {
      type: 'load';
      id: string;
      model: string;
      threads?: number;
      gpu?: boolean;
      /** Una pasada en vacío tras cargar, para que el primer dictado sea rápido. */
      warmup?: boolean;
      /** Idioma de esa pasada: el de los dictados. */
      language?: string;
    }
  | {
      type: 'transcribe';
      id: string;
      audio: string;
      language: string;
      prompt?: string;
      /** Ventana del codificador recortada a la duración del audio. */
      trim?: boolean;
      /** Búsqueda en haz con este ancho; 0 o 1: voraz. */
      beam?: number;
    }
  | { type: 'cancel'; id: string }
  | { type: 'ping'; id: string };

export interface TranscriberMemory {
  /** phys_footprint: la memoria que el sistema atribuye al proceso. */
  footprint: number;
  resident: number;
  peak?: number;
}

export type TranscriberMessage =
  | { type: 'hello'; protocol: number; whisper: string; pid: number; memory: TranscriberMemory | null }
  | {
      type: 'loaded';
      id: string;
      ms: number;
      warmupMs?: number;
      model?: string;
      multilingual?: boolean;
      memory: TranscriberMemory | null;
    }
  | {
      type: 'result';
      id: string;
      text: string;
      language: string | null;
      segments: number;
      /** Se repitió con la ventana entera porque el texto salía repetido. */
      retried: boolean;
      audioMs: number;
      ms: { total: number; encode?: number; decode?: number; prompt?: number };
      memory: TranscriberMemory | null;
    }
  | { type: 'pong'; id: string; memory: TranscriberMemory | null }
  | {
      type: 'error';
      id: string;
      code: 'bad_request' | 'model_failed' | 'not_loaded' | 'bad_audio' | 'cancelled' | 'failed';
      message: string;
    };
