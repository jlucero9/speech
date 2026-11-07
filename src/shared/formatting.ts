// Formateo del texto dictado: proveedores, modelos y estado que ve la ventana.

export type FormattingProvider = 'ollama' | 'groq' | 'gemini';

export const FORMATTING_PROVIDERS: FormattingProvider[] = ['ollama', 'groq', 'gemini'];

/** Modelo de cada proveedor. Sin selector: uno por proveedor. */
export const FORMATTING_MODELS: Record<FormattingProvider, string> = {
  ollama: 'qwen3:1.7b',
  groq: 'openai/gpt-oss-20b',
  gemini: 'gemini-3.5-flash-lite',
};

export const FORMATTING_PROVIDER_LABELS: Record<FormattingProvider, string> = {
  ollama: 'On this Mac (Ollama)',
  groq: 'Groq (your key)',
  gemini: 'Gemini (your key)',
};

export type FormattingStatus =
  | 'off' // «Smart Formatting» apagado
  | 'checking'
  | 'ready'
  | 'no_server' // Ollama no está instalado o no está en marcha
  | 'no_model' // Ollama no tiene el modelo descargado
  | 'no_key'; // proveedor en la nube sin clave

export interface FormattingState {
  provider: FormattingProvider;
  model: string;
  status: FormattingStatus;
  /** Detalle para la ventana (en inglés). */
  detail: string | null;
}

export function isFormattingProvider(value: unknown): value is FormattingProvider {
  return typeof value === 'string' && (FORMATTING_PROVIDERS as string[]).includes(value);
}
