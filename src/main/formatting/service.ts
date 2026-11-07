import { FORMATTING_MODELS, type FormattingProvider, type FormattingState } from '../../shared/formatting';
import type { ReadApiKey } from '../keys';
import { logger } from '../log';
import type { Store } from '../store';
import { GeminiFormatter, GroqFormatter } from './cloud';
import { FormatError, type FormatRequest, type FormatResult, type Formatter } from './formatter';
import { OLLAMA_URL, OllamaFormatter } from './ollama';

// El formateo visto desde el dictado: elige el proveedor según las
// preferencias, pone el límite de tiempo y, si algo falla, devuelve la
// transcripción tal cual con el motivo. Nunca lanza: el dictado siempre tiene
// algo que pegar.

const log = logger('formatting');

/**
 * Límite de tiempo: una base que cubre cargar el modelo si no llegó a
 * cargarse mientras se hablaba, más un margen por palabra para la
 * generación (~25 ms por palabra medidos con el modelo local).
 */
const TIMEOUT_BASE_MS = 3_000;
const TIMEOUT_PER_WORD_MS = 50;
/** Cuánto se queda el modelo local en memoria tras el último dictado (formato de Ollama). */
const OLLAMA_KEEP_ALIVE = '5m';

export type FormattingOutcome =
  | { result: 'formatted'; text: string; formatted: FormatResult }
  | { result: 'off'; text: string }
  | { result: `raw_${FormatError['code']}`; text: string; error: string; provider: string; model: string; ms: number };

export class TextFormatting {
  private formatter: Formatter | null = null;

  constructor(
    private readonly store: Store,
    private readonly readKey: ReadApiKey,
  ) {
    let prefs = store.get().prefs;
    let keys = store.get().apiKeys;
    store.subscribe((s) => {
      if (s.apiKeys !== keys) {
        keys = s.apiKeys;
        if (s.prefs.formattingProvider !== 'ollama') void this.check();
      }
      if (s.prefs === prefs) return;
      const changed =
        s.prefs.formattingProvider !== prefs.formattingProvider || s.prefs.smartFormatting !== prefs.smartFormatting;
      prefs = s.prefs;
      if (!changed) return;
      this.formatter?.release('provider changed');
      this.formatter = null;
      void this.check();
    });
  }

  private get enabled(): boolean {
    return this.store.get().prefs.smartFormatting;
  }

  private current(): Formatter {
    const provider = this.store.get().prefs.formattingProvider;
    if (this.formatter?.provider !== provider) this.formatter = create(provider, this.readKey);
    return this.formatter;
  }

  /** Al empezar a dictar: que el modelo vaya cargando mientras se habla. */
  prepare(): void {
    if (this.enabled) this.current().prepare();
  }

  async format(req: Omit<FormatRequest, 'signal'>, signal: AbortSignal): Promise<FormattingOutcome> {
    if (!this.enabled) return { result: 'off', text: req.text };
    const f = this.current();
    const words = req.text.split(/\s+/).filter(Boolean).length;
    const timeoutMs = TIMEOUT_BASE_MS + TIMEOUT_PER_WORD_MS * words;
    const t0 = Date.now();
    try {
      const formatted = await f.format({ ...req, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
      log.info(
        `Dictation ${req.id.slice(0, 8)}: formatted with ${f.model} in ${formatted.ms} ms` +
          (formatted.detail ? ` (${formatted.detail})` : ''),
      );
      if (this.store.get().formatting.status !== 'ready') void this.check();
      return { result: 'formatted', text: formatted.text, formatted };
    } catch (err) {
      const e = err instanceof FormatError ? err : new FormatError('failed', (err as Error).message);
      if (e.code === 'cancelled') throw e;
      log.warn(`Dictation ${req.id.slice(0, 8)}: not formatted (${e.code}), pasting the transcript: ${e.message}`);
      if (e.code === 'not_ready' || e.code === 'auth') void this.check();
      return {
        result: `raw_${e.code}`,
        text: req.text,
        error: e.message,
        provider: f.provider,
        model: f.model,
        ms: Date.now() - t0,
      };
    }
  }

  release(reason: string): void {
    this.formatter?.release(reason);
  }

  /** Comprueba si el proveedor elegido puede formatear y lo deja en el estado. */
  async check(): Promise<void> {
    const provider = this.store.get().prefs.formattingProvider;
    const model = FORMATTING_MODELS[provider];
    const set = (status: FormattingState['status'], detail: string | null): void => {
      this.store.update((s) => ({ ...s, formatting: { provider, model, status, detail } }));
    };
    if (!this.enabled) return set('off', null);
    if (provider !== 'ollama') {
      // Solo el estado: comprobar el proveedor no descifra la clave ni abre la red.
      const key = this.store.get().apiKeys[provider];
      if (key === 'saved') return set('ready', null);
      if (key === 'locked') return set('no_key', 'macOS needs your permission to read your key. Allow it in Settings › Engines and Keys.');
      return set('no_key', 'Add your key in Settings › Engines and Keys.');
    }
    // Al volver a comprobar el mismo proveedor no se pasa por «Checking…»:
    // la ventana parpadearía cada vez que recibe el foco.
    const before = this.store.get().formatting;
    if (before.provider !== provider || before.status === 'off') set('checking', null);
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2_000) });
      const body = (await res.json()) as { models?: { name: string }[] };
      const has = body.models?.some((m) => m.name === model || m.name === `${model}:latest`);
      if (has) set('ready', null);
      else set('no_model', `Run: ollama pull ${model}`);
    } catch {
      set('no_server', 'Ollama is not running. Install it from ollama.com and open it.');
    }
    const f = this.store.get().formatting;
    if (f.provider === before.provider && f.status === before.status) return;
    log.info(`Formatting with ${provider} ${model}: ${f.status}${f.detail ? ` (${f.detail})` : ''}`);
  }
}

function create(provider: FormattingProvider, readKey: ReadApiKey): Formatter {
  const model = FORMATTING_MODELS[provider];
  switch (provider) {
    case 'ollama':
      return new OllamaFormatter({ model, keepAlive: OLLAMA_KEEP_ALIVE });
    case 'groq':
      return new GroqFormatter(model, readKey);
    case 'gemini':
      return new GeminiFormatter(model, readKey);
  }
}
