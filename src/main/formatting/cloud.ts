import { FormatError, type FormatErrorCode, type FormatRequest, type FormatResult, type Formatter } from './formatter';
import type { CloudProvider } from '../../shared/engines';
import type { GroqUsage } from '../cloud-usage';
import { ApiKeyError, type ReadApiKey } from '../keys';
import { abortError } from './ollama';
import { buildMessages, checkFidelity, cleanOutput, maxOutputTokens, type ChatMessage } from './prompt';

// Formateo en la nube con la clave propia del usuario: Groq (API compatible
// con la de OpenAI) y Gemini. Apagados por defecto: con ellos, el dictado, el
// nombre de la app y los términos del diccionario salen del equipo. El texto
// alrededor del cursor no se manda: se queda aquí y solo sirve para ajustar
// espacios y mayúsculas.

abstract class CloudFormatter implements Formatter {
  abstract readonly provider: CloudProvider;

  constructor(
    readonly model: string,
    private readonly readKey: ReadApiKey,
  ) {}

  prepare(): void {}

  release(): void {}

  async format(req: FormatRequest): Promise<FormatResult> {
    let key: string;
    try {
      key = await this.readKey(this.provider);
    } catch (err) {
      throw new FormatError('not_ready', err instanceof ApiKeyError ? err.message : `Could not read the ${this.provider} key`);
    }
    const t0 = performance.now();
    let res: Response;
    try {
      res = await this.request(key, buildMessages(req), maxOutputTokens(req.text), req.signal);
    } catch (err) {
      if (req.signal?.aborted) throw abortError(req.signal);
      throw new FormatError('network', `${this.provider}: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as unknown;
    this.received(res, body);
    if (!res.ok) throw new FormatError(errorCode(res.status), `${this.provider} ${res.status}: ${errorMessage(body)}`);
    const text = cleanOutput(this.extract(body));
    const rejected = checkFidelity(req.text, text, req.vocabulary);
    if (rejected) throw new FormatError('rejected', `${this.model}: ${rejected}: «${text.slice(0, 200)}»`);
    return { text, provider: this.provider, model: this.model, ms: Math.round(performance.now() - t0) };
  }

  /** Cada respuesta del proveedor, para quien lleve la cuenta del uso. */
  protected received(_res: Response, _body: unknown): void {}

  protected abstract request(key: string, messages: ChatMessage[], maxTokens: number, signal?: AbortSignal): Promise<Response>;
  protected abstract extract(body: unknown): string;
}

export class GroqFormatter extends CloudFormatter {
  readonly provider = 'groq';

  constructor(
    model: string,
    readKey: ReadApiKey,
    private readonly usage?: GroqUsage,
  ) {
    super(model, readKey);
  }

  protected received(res: Response, body: unknown): void {
    if (res.ok) this.usage?.recordFormatting(res, body);
    else if (res.status === 429) this.usage?.recordLimited(res);
  }

  protected request(key: string, messages: ChatMessage[], maxTokens: number, signal?: AbortSignal): Promise<Response> {
    // gpt-oss siempre razona (como mínimo, «low»); en Qwen se puede apagar.
    const reasoning = this.model.startsWith('openai/gpt-oss')
      ? { reasoning_effort: 'low', include_reasoning: false }
      : this.model.startsWith('qwen/')
        ? { reasoning_effort: 'none' }
        : {};
    return fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      // Los modelos que razonan gastan tokens antes de responder: margen aparte.
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0,
        max_completion_tokens: maxTokens + (reasoning.reasoning_effort === 'low' ? 512 : 0),
        ...reasoning,
      }),
      signal,
    });
  }

  protected extract(body: unknown): string {
    const b = body as { choices?: { message?: { content?: string } }[] };
    return b.choices?.[0]?.message?.content ?? '';
  }
}

export class GeminiFormatter extends CloudFormatter {
  readonly provider = 'gemini';

  protected request(key: string, messages: ChatMessage[], maxTokens: number, signal?: AbortSignal): Promise<Response> {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0,
          // El razonamiento cuenta dentro del tope: margen aparte. Flash no
          // admite menos de «low»; Flash-Lite, «minimal».
          maxOutputTokens: maxTokens + 1024,
          thinkingConfig: { thinkingLevel: this.model.includes('flash-lite') ? 'minimal' : 'low' },
        },
      }),
      signal,
    });
  }

  protected extract(body: unknown): string {
    const b = body as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
    return (b.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
  }
}

function errorCode(status: number): FormatErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  return 'failed';
}

function errorMessage(body: unknown): string {
  const b = body as { error?: { message?: string } | string };
  if (typeof b?.error === 'string') return b.error;
  return b?.error?.message ?? 'unknown error';
}
