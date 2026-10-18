// Frontera «texto y contexto entran, texto formateado sale». El dictado solo
// conoce esta interfaz; cada proveedor (Ollama en el equipo, Groq y Gemini en
// la nube) la implementa por su cuenta.

/** Lo que rodea al cursor en el campo donde se va a pegar. */
export interface TextSurroundings {
  /** Texto antes del cursor (o de la selección), recortado. */
  before: string;
  /** Texto después del cursor (o de la selección), recortado. */
  after: string;
  /** Texto seleccionado, que el pegado va a sustituir. */
  selected: string;
}

export interface FormatRequest {
  /** Identificador del dictado, para el registro. */
  id: string;
  /** Transcripción tal cual. */
  text: string;
  /** Código ISO 639-1 del dictado. */
  language: string;
  /** App donde se va a pegar. */
  appName: string | null;
  /** Texto alrededor del cursor; null si el campo no deja leerlo. */
  surroundings: TextSurroundings | null;
  /** Términos del diccionario, por orden de prioridad. */
  vocabulary: string[];
  signal?: AbortSignal;
}

export interface FormatResult {
  text: string;
  provider: string;
  model: string;
  /** Desde la petición hasta tener el texto. */
  ms: number;
  /** Desglose del proveedor, para el registro (carga, lectura del prompt, generación…). */
  detail?: string;
}

export type FormatErrorCode =
  | 'not_ready' // sin servidor, sin modelo o sin clave
  | 'cancelled'
  | 'timeout'
  | 'rejected' // la respuesta no es una versión fiel del dictado
  | 'failed' // error del proveedor
  | 'network'
  | 'auth'
  | 'quota';

export class FormatError extends Error {
  constructor(
    readonly code: FormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FormatError';
  }
}

export interface Formatter {
  readonly provider: string;
  readonly model: string;
  /** Aviso de que llega un dictado: cargar el modelo mientras el usuario habla. No falla nunca. */
  prepare(): void;
  format(request: FormatRequest): Promise<FormatResult>;
  /** Libera lo que ocupe (el modelo en memoria). */
  release(reason: string): void;
}
