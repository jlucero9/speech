import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { GROQ_DAILY_LIMITS } from '../shared/engines';
import { logger } from './log';
import type { Store } from './store';

// Cuánto se ha gastado del plan gratuito de Groq, para enseñarlo como un
// porcentaje. Groq no tiene un sitio donde preguntarlo: cada respuesta trae
// las peticiones que quedan en el día, pero no los tokens ni los segundos de
// audio, así que se apuntan aquí los de cada petición de las últimas 24 horas.
// Se guarda en un fichero para que reiniciar la app no ponga la cuenta a cero.

const log = logger('cloud-usage');

const DAY_MS = 24 * 60 * 60 * 1000;
/** Groq cobra cada audio como si durara al menos 10 s; se cuenta igual. */
const MIN_AUDIO_SECONDS = 10;
/** Un 429 que pide esperar menos es el límite por minuto, no el del día. */
const DAILY_LIMIT_RETRY_S = 60;
const SAVE_DELAY_MS = 2_000;
const REFRESH_MS = 10 * 60 * 1000;

type Kind = 'transcription' | 'formatting';

interface Entry {
  t: number;
  kind: Kind;
  /** Segundos de audio (transcripción) o tokens (formateo). */
  amount: number;
}

/** Lo que dijo Groq en la última respuesta: tope y peticiones que quedan en el día. */
interface RequestHeaders {
  t: number;
  limit: number;
  remaining: number;
}

interface FileShape {
  version: 1;
  entries: Entry[];
  headers: Partial<Record<Kind, RequestHeaders>>;
  limitedUntil: number | null;
}

export class GroqUsage {
  private entries: Entry[] = [];
  private headers: Partial<Record<Kind, RequestHeaders>> = {};
  private limitedUntil: number | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly path: string,
  ) {
    this.load();
    this.publish();
    // Lo de hace un día va dejando de contar aunque no se dicte.
    setInterval(() => this.publish(), REFRESH_MS).unref();
  }

  /** Una transcripción que Groq aceptó. */
  recordTranscription(res: Response, audioMs: number): void {
    this.readHeaders('transcription', res);
    this.add('transcription', Math.max(MIN_AUDIO_SECONDS, audioMs / 1000));
  }

  /** Un formateo que Groq aceptó; los tokens, de su respuesta. */
  recordFormatting(res: Response, body: unknown): void {
    this.readHeaders('formatting', res);
    const tokens = (body as { usage?: { total_tokens?: number } })?.usage?.total_tokens;
    this.add('formatting', typeof tokens === 'number' && tokens > 0 ? tokens : 0);
    if (typeof tokens === 'number') log.info(`Groq formatting used ${tokens} tokens; usage today ${this.store.get().cloudUsage.groq.percent}%`);
  }

  /** Groq contestó 429. */
  recordLimited(res: Response): void {
    const retry = Number(res.headers.get('retry-after'));
    if (!Number.isFinite(retry) || retry < DAILY_LIMIT_RETRY_S) return;
    this.limitedUntil = Date.now() + retry * 1000;
    log.warn(`Groq daily limit reached; it accepts requests again in ${Math.round(retry / 60)} min`);
    this.publish();
    this.scheduleSave();
  }

  private readHeaders(kind: Kind, res: Response): void {
    const limit = Number(res.headers.get('x-ratelimit-limit-requests'));
    const remaining = Number(res.headers.get('x-ratelimit-remaining-requests'));
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining >= 0) {
      this.headers[kind] = { t: Date.now(), limit, remaining };
    }
  }

  private add(kind: Kind, amount: number): void {
    this.entries.push({ t: Date.now(), kind, amount });
    // Si Groq vuelve a aceptar, el límite ya pasó.
    this.limitedUntil = null;
    this.publish();
    this.scheduleSave();
  }

  /** El porcentaje del límite que esté más cerca de agotarse. */
  private percent(now: number): number {
    if (this.limitedUntil && this.limitedUntil > now) return 100;
    const since = now - DAY_MS;
    const recent = this.entries.filter((e) => e.t > since);
    const ratios: number[] = [];
    for (const kind of ['transcription', 'formatting'] as const) {
      const mine = recent.filter((e) => e.kind === kind);
      const h = this.headers[kind];
      const fresh = h && h.t > since ? h : null;
      const limit = fresh?.limit ?? GROQ_DAILY_LIMITS[kind].requests;
      // Groq lleva la cuenta de verdad de las peticiones; la nuestra cubre lo que no dice.
      const used = Math.max(mine.length, fresh ? fresh.limit - fresh.remaining : 0);
      ratios.push(used / limit);
      const amount = mine.reduce((sum, e) => sum + e.amount, 0);
      ratios.push(kind === 'transcription' ? amount / GROQ_DAILY_LIMITS.transcription.audioSeconds : amount / GROQ_DAILY_LIMITS.formatting.tokens);
    }
    return Math.min(100, Math.round(Math.max(0, ...ratios) * 100));
  }

  private publish(): void {
    const now = Date.now();
    this.entries = this.entries.filter((e) => e.t > now - DAY_MS);
    if (this.limitedUntil && this.limitedUntil <= now) this.limitedUntil = null;
    const next = { percent: this.percent(now), limitedUntil: this.limitedUntil, updatedAt: this.entries.at(-1)?.t ?? null };
    const cur = this.store.get().cloudUsage.groq;
    if (cur.percent === next.percent && cur.limitedUntil === next.limitedUntil && cur.updatedAt === next.updatedAt) return;
    this.store.update((s) => ({ ...s, cloudUsage: { ...s.cloudUsage, groq: next } }));
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      if (Array.isArray(data.entries)) {
        this.entries = data.entries.filter(
          (e) => e && typeof e.t === 'number' && (e.kind === 'transcription' || e.kind === 'formatting') && typeof e.amount === 'number',
        );
      }
      if (data.headers && typeof data.headers === 'object') this.headers = data.headers;
      if (typeof data.limitedUntil === 'number') this.limitedUntil = data.limitedUntil;
    } catch {
      // Sin fichero (o dañado): se empieza a contar desde ahora.
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  /** También al cerrar la app, para no perder lo último. */
  save(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const data: FileShape = { version: 1, entries: this.entries, headers: this.headers, limitedUntil: this.limitedUntil };
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.path);
    } catch (err) {
      log.warn(`Could not save Groq usage: ${(err as Error).message}`);
    }
  }
}
