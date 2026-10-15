// Frontera «audio entra, texto sale». El dictado solo conoce esta interfaz;
// cada motor (whisper.cpp en el equipo y, más adelante, los de la nube) la
// implementa por su cuenta.

export interface TranscriptionRequest {
  /** Identificador del dictado, para el registro y para cancelar. */
  id: string;
  /** WAV PCM de 16 bits, 16 kHz, mono. El mismo fichero para todos los motores. */
  audioPath: string;
  durationMs: number;
  /** Código ISO 639-1. */
  language: string;
  /** Términos del diccionario. Pista opcional: cada motor la usa como pueda. */
  vocabulary: string[];
  /** Cancela la transcripción: la promesa se rechaza con código 'cancelled'. */
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  /** Idioma del texto. */
  language: string | null;
  engine: string;
  model: string;
  /** Desde la petición hasta tener el texto, esperas de carga incluidas. */
  ms: number;
}

export type TranscriptionErrorCode =
  | 'not_ready' // el motor no puede transcribir todavía (modelo sin descargar, sin clave…)
  | 'cancelled'
  | 'bad_audio' // el fichero no se puede leer o no tiene el formato esperado
  | 'timeout'
  | 'engine_failed' // el motor falló (proceso caído, error interno)
  | 'network' // motores en la nube: sin conexión o el servidor no responde
  | 'auth' // motores en la nube: clave no válida
  | 'quota'; // motores en la nube: límite de uso

export class TranscriptionError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

export interface TranscriptionEngine {
  readonly id: string;
  /**
   * Aviso de que llega un dictado: el motor puede ir preparándose (cargar el
   * modelo, abrir la conexión) mientras el usuario habla. No falla nunca.
   */
  prepare(language: string): void;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
  /** Libera lo que ocupe. Se puede volver a usar después. */
  release(reason: string): void;
}
