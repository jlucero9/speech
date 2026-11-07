// Motores opcionales en la nube: proveedores, modelos y estado de sus claves.

export type CloudProvider = 'groq' | 'gemini';

export const CLOUD_PROVIDERS: CloudProvider[] = ['groq', 'gemini'];

export const CLOUD_PROVIDER_NAMES: Record<CloudProvider, string> = { groq: 'Groq', gemini: 'Gemini' };

export type TranscriptionEngineId = 'local' | CloudProvider;

export const TRANSCRIPTION_ENGINES: TranscriptionEngineId[] = ['local', 'groq', 'gemini'];

/** Modelo de cada motor en la nube. Sin selector: uno por proveedor. */
export const TRANSCRIPTION_MODELS: Record<CloudProvider, string> = {
  groq: 'whisper-large-v3-turbo',
  gemini: 'gemini-3.5-flash-lite',
};

export function isTranscriptionEngine(value: unknown): value is TranscriptionEngineId {
  return typeof value === 'string' && (TRANSCRIPTION_ENGINES as string[]).includes(value);
}

export function isCloudProvider(value: unknown): value is CloudProvider {
  return typeof value === 'string' && (CLOUD_PROVIDERS as string[]).includes(value);
}

/**
 * saved: está en el llavero. locked: está, pero macOS pide permiso para leerla
 * (pasa si cambia la firma de la app). unavailable: no se pudo usar el llavero.
 */
export type ApiKeyStatus = 'unknown' | 'saved' | 'missing' | 'locked' | 'unavailable';

export type ApiKeysState = Record<CloudProvider, ApiKeyStatus>;

export type ApiKeyResult = { ok: true } | { ok: false; message: string };

export function isPlausibleApiKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}
