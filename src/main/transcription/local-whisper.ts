import type { TranscriberState } from '../../shared/transcription';
import { logger } from '../log';
import type { Store } from '../store';
import {
  TranscriptionError,
  type TranscriptionEngine,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './engine';
import type { ModelManager } from './models';
import { TranscriberProcess, TranscriberProcessError } from './transcriber-process';

// Motor local: whisper.cpp en un proceso aparte (SpeechTranscriber).
//
// El modelo ocupa unos 700 MB mientras está cargado, así que no se carga hasta
// que hace falta y se suelta en cuanto deja de hacer falta:
// - Al empezar un dictado (prepare) se lanza el proceso y se carga el modelo
//   mientras el usuario habla; al soltar la tecla suele estar listo.
// - Tras IDLE_UNLOAD_MS sin dictar o al suspender el equipo, se cierra el
//   proceso. Cerrarlo devuelve toda la memoria al sistema.
//
// Un proceso aparte, y no un módulo dentro de main, para que un fallo de
// whisper.cpp o de Metal no tumbe la app y para poder liberar la memoria sin
// depender de que la biblioteca la suelte entera.

const log = logger('whisper');

const IDLE_UNLOAD_MS = 5 * 60_000;
/** Plazo de una transcripción: fijo más una parte de la duración del audio. */
const TIMEOUT_BASE_MS = 30_000;
const TIMEOUT_PER_AUDIO_MS = 0.5;
/** Núcleos de alto rendimiento de un M1; con más hilos no va más rápido. */
const THREADS = 4;
/** Whisper usa como mucho unos 224 tokens de pista. */
const MAX_PROMPT_CHARS = 600;
/**
 * Búsqueda en haz: en dictados largos acierta más palabras que la voraz, a
 * cambio de ~0,1 s en una frase corta y ~0,6 s en 30 s de audio.
 */
const BEAM_SIZE = 5;
/**
 * Texto previo con puntuación en el idioma del dictado. Sin él, los dictados
 * largos salen a menudo sin puntos, comas ni mayúsculas. Frases neutras: con
 * palabras que se dicen mucho («esto», «esta»…), el modelo tiende a copiarlas.
 */
const STYLE_PROMPTS: Record<string, string> = {
  es: 'Hola, ¿qué tal? Bien, gracias.',
  en: 'Hello, how are you? Fine, thanks.',
  pt: 'Olá, tudo bem? Tudo bem, obrigado.',
  ca: 'Hola, què tal? Bé, gràcies.',
  fr: 'Bonjour, ça va ? Oui, merci.',
  it: 'Ciao, come stai? Bene, grazie.',
  de: 'Hallo, wie geht’s? Gut, danke.',
  nl: 'Hallo, hoe gaat het? Goed, dank je.',
};

interface Loaded {
  proc: TranscriberProcess;
  /** Se resuelve con el modelo cargado; se rechaza si la carga falla. */
  loading: Promise<void>;
}

export class LocalWhisper implements TranscriptionEngine {
  readonly id = 'local';
  private worker: Loaded | null = null;
  private busy = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly models: ModelManager,
    private readonly executable: string,
  ) {}

  prepare(language: string): void {
    if (!this.models.ready) return;
    this.clearIdle();
    this.ensureLoaded(language).catch((err: Error) => log.warn(`Could not prepare the model: ${err.message}`));
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const t0 = performance.now();
    const modelId = this.models.id;
    if (!this.models.ready) {
      const m = this.models.state;
      const pct = m.totalBytes ? Math.floor((m.receivedBytes / m.totalBytes) * 100) : 0;
      throw new TranscriptionError(
        'not_ready',
        m.status === 'downloading' || m.status === 'verifying'
          ? `The speech model is still downloading (${pct}%).`
          : 'The speech model is not downloaded yet.',
      );
    }
    if (req.signal?.aborted) throw new TranscriptionError('cancelled', 'Cancelled.');

    this.busy++;
    this.clearIdle();
    this.setTranscriber({ status: 'busy' });
    try {
      const w = await this.ensureLoaded(req.language);
      if (req.signal?.aborted) throw new TranscriptionError('cancelled', 'Cancelled.');
      const prompt = buildPrompt(req.language, req.vocabulary);
      const { id, reply } = w.proc.request<'result'>({
        type: 'transcribe',
        audio: req.audioPath,
        language: req.language,
        trim: true,
        beam: BEAM_SIZE,
        ...(prompt ? { prompt } : {}),
      });

      // whisper.cpp solo atiende el aborto entre pasos del codificador (hasta
      // ~1,5 s con turbo). No hace falta esperarlo: el transcriptor ejecuta las
      // órdenes en cola, así que la siguiente irá detrás de la cancelada.
      let onAbort = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => {
          w.proc.notify({ type: 'cancel', id });
          reject(new TranscriptionError('cancelled', 'Cancelled.'));
        };
      });
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const limit = TIMEOUT_BASE_MS + req.durationMs * TIMEOUT_PER_AUDIO_MS;
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Colgado o demasiado lento: se cierra el proceso; el siguiente dictado abre otro.
          log.error(`Transcription ${short(req.id)} took more than ${Math.round(limit / 1000)} s; killing the transcriber`);
          w.proc.kill();
          reject(new TranscriptionError('timeout', 'Transcription took too long.'));
        }, limit);
      });
      try {
        const r = await Promise.race([reply, timeout, cancelled]);
        const ms = Math.round(performance.now() - t0);
        log.info(
          `Transcribed ${short(req.id)}: ${(r.audioMs / 1000).toFixed(1)} s of audio in ${ms} ms ` +
            `(whisper ${Math.round(r.ms.total)} ms, encoder ${Math.round(r.ms.encode ?? 0)} ms, ` +
            `language ${r.language ?? '?'}${r.retried ? ', retried with the full window' : ''}), ${r.text.length} chars`,
        );
        if (r.memory) this.setTranscriber({ memoryBytes: r.memory.footprint });
        return { text: r.text, language: r.language, engine: this.id, model: modelId, ms };
      } finally {
        if (timer) clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
      }
    } catch (err) {
      throw toTranscriptionError(err);
    } finally {
      this.busy--;
      if (this.worker && this.busy === 0) {
        this.setTranscriber({ status: 'ready' });
        this.scheduleIdle();
      }
    }
  }

  release(reason: string): void {
    this.clearIdle();
    const w = this.worker;
    if (!w) return;
    log.info(`Unloading the model (${reason})`);
    this.worker = null;
    w.proc.stop();
    this.setTranscriber({ status: 'stopped', pid: null, memoryBytes: null, unloadAt: null, error: null });
  }

  private ensureLoaded(language: string): Promise<Loaded> {
    if (!this.worker) this.worker = this.spawn(this.models.path(), language);
    const w = this.worker;
    return w.loading.then(() => w);
  }

  private spawn(modelPath: string, language: string): Loaded {
    const t0 = performance.now();
    const proc = new TranscriberProcess(this.executable);
    this.setTranscriber({ status: 'loading', pid: proc.pid, memoryBytes: null, unloadAt: null, error: null });
    const loading = (async () => {
      await proc.ready;
      const { reply } = proc.request<'loaded'>({
        type: 'load',
        model: modelPath,
        threads: THREADS,
        warmup: true,
        language,
      });
      const r = await reply;
      log.info(
        `Model ${this.models.id} loaded in ${Math.round(performance.now() - t0)} ms ` +
          `(read ${Math.round(r.ms)} ms, warm-up ${Math.round(r.warmupMs ?? 0)} ms, ` +
          `${r.memory ? Math.round(r.memory.footprint / 1024 / 1024) : '?'} MB)`,
      );
      if (this.worker?.proc === proc) {
        this.setTranscriber({ status: this.busy ? 'busy' : 'ready', memoryBytes: r.memory?.footprint ?? null });
        if (!this.busy) this.scheduleIdle();
      }
    })();
    const w: Loaded = { proc, loading };
    loading.catch((err: Error) => {
      log.error(`Could not load the model: ${err.message}`);
      proc.kill();
    });
    proc.on('exit', (code, signal) => {
      if (this.worker !== w) return;
      // Salida inesperada: el siguiente dictado lanzará otro proceso.
      log.warn(`Transcriber exited unexpectedly (${signal ?? `code ${code}`})`);
      this.worker = null;
      this.clearIdle();
      this.setTranscriber({
        status: 'failed',
        pid: null,
        memoryBytes: null,
        unloadAt: null,
        error: `The transcriber quit (${signal ?? `code ${code}`}).`,
      });
    });
    return w;
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.release('idle'), IDLE_UNLOAD_MS);
    this.setTranscriber({ unloadAt: Date.now() + IDLE_UNLOAD_MS });
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.store.get().transcription.transcriber.unloadAt) this.setTranscriber({ unloadAt: null });
  }

  private setTranscriber(p: Partial<TranscriberState>): void {
    this.store.update((s) => ({
      ...s,
      transcription: { ...s.transcription, transcriber: { ...s.transcription.transcriber, ...p } },
    }));
  }
}

/**
 * Texto previo: la frase de estilo del idioma y los términos del diccionario
 * (whisper tiende a escribirlos igual que en la pista).
 */
function buildPrompt(language: string, terms: string[]): string {
  let prompt = STYLE_PROMPTS[language] ?? '';
  let list = '';
  for (const t of terms) {
    const next = list ? `${list}, ${t}` : t;
    if (prompt.length + 1 + next.length > MAX_PROMPT_CHARS) break;
    list = next;
  }
  if (list) prompt = prompt ? `${prompt} ${list}` : list;
  return prompt;
}

function toTranscriptionError(err: unknown): TranscriptionError {
  if (err instanceof TranscriptionError) return err;
  if (err instanceof TranscriberProcessError) {
    switch (err.code) {
      case 'cancelled':
        return new TranscriptionError('cancelled', 'Cancelled.');
      case 'bad_audio':
        return new TranscriptionError('bad_audio', `Could not read the recording: ${err.message}`);
      case 'model_failed':
        return new TranscriptionError('engine_failed', 'Could not load the speech model.');
      default:
        return new TranscriptionError('engine_failed', `Transcription failed: ${err.message}`);
    }
  }
  return new TranscriptionError('engine_failed', `Transcription failed: ${(err as Error).message}`);
}

function short(id: string): string {
  return id.slice(0, 8);
}
