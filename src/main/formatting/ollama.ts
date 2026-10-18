import { FormatError, type FormatRequest, type FormatResult, type Formatter } from './formatter';
import { buildMessages, checkFidelity, cleanOutput, maxOutputTokens } from './prompt';

// Formateo local con Ollama, un programa aparte que escucha en 127.0.0.1:11434.
// La app no lo instala ni lo arranca: si no responde, el dictado se pega sin
// formatear. El modelo se carga al empezar a dictar (mientras el usuario
// habla) y Ollama lo suelta solo cuando pasa `keepAlive` sin usarlo.

export const OLLAMA_URL = 'http://127.0.0.1:11434';

/** Mismas opciones en la preparación y en el formateo: si cambian, Ollama recarga el modelo. */
const OPTIONS = { temperature: 0, num_ctx: 2048 };

export interface OllamaOptions {
  model: string;
  /** Cuánto se queda el modelo en memoria tras el último uso, en el formato de Ollama ("5m", "0", "-1"). */
  keepAlive: string;
  url?: string;
}

export class OllamaFormatter implements Formatter {
  readonly provider = 'ollama';
  readonly model: string;
  private readonly url: string;

  constructor(private readonly options: OllamaOptions) {
    this.model = options.model;
    this.url = options.url ?? OLLAMA_URL;
  }

  prepare(): void {
    // Se envía siempre, aunque el modelo se haya usado hace poco: Ollama puede
    // haberlo soltado por su cuenta, y con el modelo listo cuesta ~0,1 s de GPU
    // mientras el usuario habla. Un formateo de prueba de un solo token: carga el modelo y deja procesada
    // la parte fija del prompt (instrucciones y ejemplos), que Ollama reutiliza
    // en la petición siguiente. En frío son ~2 s de carga y ~1 s de prompt que
    // así pasan mientras el usuario habla.
    const messages = buildMessages({ id: 'warm-up', text: '.', language: 'en', appName: null, surroundings: null, vocabulary: [] });
    void this.post('/api/chat', {
      model: this.model,
      messages,
      stream: false,
      think: false,
      keep_alive: this.options.keepAlive,
      options: { ...OPTIONS, num_predict: 1 },
    }).catch(() => {});
  }

  async format(req: FormatRequest): Promise<FormatResult> {
    const t0 = performance.now();
    const res = await this.post(
      '/api/chat',
      {
        model: this.model,
        messages: buildMessages(req),
        stream: false,
        think: false,
        keep_alive: this.options.keepAlive,
        options: { ...OPTIONS, num_predict: maxOutputTokens(req.text) },
      },
      req.signal,
    );
    const body = (await res.json()) as OllamaChatResponse;
    if (!res.ok) {
      const code = res.status === 404 ? 'not_ready' : 'failed';
      throw new FormatError(code, `Ollama: ${body.error ?? res.status}`);
    }
    const text = cleanOutput(body.message?.content ?? '');
    const rejected = checkFidelity(req.text, text, req.vocabulary);
    if (rejected) throw new FormatError('rejected', `${this.model}: ${rejected}: «${text.slice(0, 200)}»`);
    const ms = (ns?: number) => Math.round((ns ?? 0) / 1e6);
    const detail =
      `load ${ms(body.load_duration)} ms, prompt ${body.prompt_eval_count ?? 0} tokens in ${ms(body.prompt_eval_duration)} ms, ` +
      `output ${body.eval_count ?? 0} tokens in ${ms(body.eval_duration)} ms`;
    return { text, provider: this.provider, model: this.model, ms: Math.round(performance.now() - t0), detail };
  }

  release(): void {
    void this.post('/api/chat', { model: this.model, messages: [], keep_alive: 0 }).catch(() => {});
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      return await fetch(this.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw abortError(signal);
      throw new FormatError('not_ready', `Ollama is not responding (${(err as Error).message})`);
    }
  }
}

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export function abortError(signal: AbortSignal): FormatError {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === 'TimeoutError'
    ? new FormatError('timeout', 'formatting took too long')
    : new FormatError('cancelled', 'cancelled');
}
