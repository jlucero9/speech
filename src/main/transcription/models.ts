import { net } from 'electron';
import { createHash, type Hash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createReadStream, mkdirSync } from 'node:fs';
import { open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_MODELS, type LocalModelId, type ModelState } from '../../shared/transcription';
import { logger } from '../log';
import type { Store } from '../store';

// Modelos de whisper.cpp: se descargan la primera vez, se comprueba su SHA-256
// y desde entonces se usan sin red.
//
// - La descarga va a `<fichero>.part` y se reanuda donde se quedó (cabecera
//   Range), también tras cerrar la app.
// - Solo al cuadrar tamaño y hash se renombra al nombre definitivo y se anota
//   en `<fichero>.verified.json`. Al arrancar basta con comparar ese registro
//   con el fichero; si no cuadra (o no existe), se vuelve a calcular el hash.
// - Las URL apuntan a una revisión fija del repositorio, así que el contenido
//   no puede cambiar por debajo.

const log = logger('models');

const REPOSITORY = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1';
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000];
const PROGRESS_EVERY_MS = 250;
const SPEED_WINDOW_MS = 3_000;
/** Margen de disco libre además del propio modelo. */
const DISK_MARGIN_BYTES = 200 * 1024 * 1024;

interface Verified {
  sha256: string;
  size: number;
  mtimeMs: number;
}

interface ModelEvents {
  ready: [id: LocalModelId];
}

class DownloadError extends Error {
  constructor(
    message: string,
    /** false: reintentar no sirve (disco lleno, hash que no cuadra dos veces…). */
    readonly retryable = true,
  ) {
    super(message);
  }
}

export class ModelManager extends EventEmitter<ModelEvents> {
  private readonly current: LocalModelId;
  /** Cancela la tarea en curso (comprobación o descarga) del modelo actual. */
  private abort: AbortController | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempts = 0;

  constructor(
    private readonly store: Store,
    private readonly dir: string,
    initial: LocalModelId,
  ) {
    super();
    mkdirSync(dir, { recursive: true });
    this.current = initial;
  }

  get id(): LocalModelId {
    return this.current;
  }

  get state(): ModelState {
    return this.store.get().transcription.model;
  }

  get ready(): boolean {
    return this.state.id === this.current && this.state.status === 'ready';
  }

  path(id: LocalModelId = this.current): string {
    return join(this.dir, LOCAL_MODELS[id].file);
  }

  /** Comprueba el modelo elegido y, si falta, empieza a descargarlo. */
  start(): void {
    void this.run(true);
  }

  /** Botón «Download» / «Try again»: reanuda sin esperar al reintento automático. */
  download(): void {
    if (this.state.status === 'downloading' || this.state.status === 'verifying' || this.ready) return;
    this.attempts = 0;
    void this.run(true);
  }

  stop(): void {
    this.cancelTask();
  }

  private cancelTask(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async run(download: boolean): Promise<void> {
    this.cancelTask();
    const id = this.current;
    const ctrl = new AbortController();
    this.abort = ctrl;
    const spec = LOCAL_MODELS[id];
    this.set({
      id,
      status: 'checking',
      receivedBytes: 0,
      totalBytes: spec.sizeBytes,
      bytesPerSecond: null,
      error: null,
      retryAt: null,
    });
    try {
      if (await this.check(id, ctrl.signal)) {
        this.set({ status: 'ready', receivedBytes: spec.sizeBytes });
        log.info(`Model ${id} ready (${this.path(id)})`);
        this.attempts = 0;
        this.emit('ready', id);
        return;
      }
      if (!download) {
        this.set({ status: 'missing' });
        return;
      }
      await this.fetch(id, ctrl.signal);
      if (ctrl.signal.aborted) return;
      this.set({ status: 'ready', receivedBytes: spec.sizeBytes, bytesPerSecond: null });
      log.info(`Model ${id} downloaded and verified`);
      this.attempts = 0;
      this.emit('ready', id);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const e = err instanceof DownloadError ? err : new DownloadError((err as Error).message);
      this.fail(id, e);
    } finally {
      if (this.abort === ctrl) this.abort = null;
    }
  }

  private fail(id: LocalModelId, e: DownloadError): void {
    const delay = e.retryable ? RETRY_DELAYS_MS[this.attempts] : undefined;
    this.attempts++;
    log.warn(`Model ${id}: ${e.message}${delay ? `; retrying in ${delay / 1000} s` : ''}`);
    this.set({ status: 'failed', error: e.message, bytesPerSecond: null, retryAt: delay ? Date.now() + delay : null });
    if (delay) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.run(true);
      }, delay);
    }
  }

  /** ¿Está el modelo en disco y verificado? Si hay fichero sin registro, calcula el hash. */
  private async check(id: LocalModelId, signal: AbortSignal): Promise<boolean> {
    const spec = LOCAL_MODELS[id];
    const file = this.path(id);
    const info = await stat(file).catch(() => null);
    if (!info) return false;
    if (info.size !== spec.sizeBytes) {
      log.warn(`Model ${id} has the wrong size (${info.size}), deleting it`);
      await this.removeModel(id);
      return false;
    }
    const verified = await readFile(`${file}.verified.json`, 'utf8')
      .then((t) => JSON.parse(t) as Verified)
      .catch(() => null);
    if (verified && verified.sha256 === spec.sha256 && verified.size === info.size && verified.mtimeMs === info.mtimeMs) {
      return true;
    }
    this.set({ status: 'verifying', receivedBytes: spec.sizeBytes });
    const hash = await hashFile(file, signal);
    if (signal.aborted) return false;
    if (hash !== spec.sha256) {
      log.warn(`Model ${id} does not match its SHA-256 (${hash}), deleting it`);
      await this.removeModel(id);
      return false;
    }
    await this.markVerified(id);
    return true;
  }

  private async fetch(id: LocalModelId, signal: AbortSignal): Promise<void> {
    const spec = LOCAL_MODELS[id];
    const file = this.path(id);
    const part = `${file}.part`;

    // Lo que ya hay de una descarga anterior: se reanuda y se incluye en el hash.
    let offset = (await stat(part).catch(() => null))?.size ?? 0;
    if (offset > spec.sizeBytes) {
      await rm(part, { force: true });
      offset = 0;
    }
    await this.ensureSpace(spec.sizeBytes - offset);
    let hash = createHash('sha256');
    if (offset > 0) {
      this.set({ status: 'verifying', receivedBytes: offset });
      hash = await hashInto(hash, part, signal);
      if (signal.aborted) return;
    }

    const url = `${REPOSITORY}/${spec.file}`;
    log.info(`Downloading ${spec.file}${offset ? ` from byte ${offset}` : ''}`);
    this.set({ status: 'downloading', receivedBytes: offset });
    const response = await net
      .fetch(url, { signal, headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} })
      .catch((err: Error) => {
        throw new DownloadError(signal.aborted ? 'aborted' : `Could not connect: ${err.message}`);
      });
    if (response.status === 200 && offset > 0) {
      // El servidor ignoró el Range: se empieza de cero.
      log.info('Server sent the whole file; starting over');
      offset = 0;
      hash = createHash('sha256');
    } else if (response.status !== 200 && response.status !== 206) {
      throw new DownloadError(`The server answered ${response.status}`);
    }
    if (!response.body) throw new DownloadError('Empty response');

    const out = await open(part, offset > 0 ? 'a' : 'w');
    let received = offset;
    let lastReport = 0;
    const samples: { t: number; bytes: number }[] = [];
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read().catch((err: Error) => {
          throw new DownloadError(signal.aborted ? 'aborted' : `Download interrupted: ${err.message}`);
        });
        if (done) break;
        await out.write(value);
        hash.update(value);
        received += value.byteLength;
        if (received > spec.sizeBytes) throw new DownloadError('The file is bigger than expected');
        const now = Date.now();
        samples.push({ t: now, bytes: received });
        while (samples.length > 1 && now - samples[0].t > SPEED_WINDOW_MS) samples.shift();
        if (now - lastReport >= PROGRESS_EVERY_MS) {
          lastReport = now;
          const first = samples[0];
          const speed = now > first.t ? ((received - first.bytes) * 1000) / (now - first.t) : null;
          this.set({ receivedBytes: received, bytesPerSecond: speed });
        }
      }
    } finally {
      await out.close();
    }
    if (signal.aborted) return;
    this.set({ receivedBytes: received, bytesPerSecond: null });
    if (received !== spec.sizeBytes) {
      throw new DownloadError(`Download incomplete (${received} of ${spec.sizeBytes} bytes)`);
    }
    this.set({ status: 'verifying' });
    const digest = hash.digest('hex');
    if (digest !== spec.sha256) {
      // Lo descargado está dañado: se borra para que el reintento empiece de cero.
      await rm(part, { force: true });
      throw new DownloadError('The downloaded file is damaged (checksum mismatch)');
    }
    await rename(part, file);
    await this.markVerified(id);
  }

  private async ensureSpace(bytes: number): Promise<void> {
    try {
      const fs = await statfs(this.dir);
      const free = fs.bavail * fs.bsize;
      if (free < bytes + DISK_MARGIN_BYTES) {
        throw new DownloadError(`Not enough disk space: ${mb(bytes + DISK_MARGIN_BYTES)} MB needed, ${mb(free)} MB free`, false);
      }
    } catch (err) {
      if (err instanceof DownloadError) throw err;
      log.warn(`Could not check free disk space: ${(err as Error).message}`);
    }
  }

  private async markVerified(id: LocalModelId): Promise<void> {
    const file = this.path(id);
    const info = await stat(file);
    const record: Verified = { sha256: LOCAL_MODELS[id].sha256, size: info.size, mtimeMs: info.mtimeMs };
    await writeFile(`${file}.verified.json`, JSON.stringify(record) + '\n');
  }

  private async removeModel(id: LocalModelId): Promise<void> {
    const file = this.path(id);
    await rm(file, { force: true });
    await rm(`${file}.verified.json`, { force: true });
  }

  private set(p: Partial<ModelState>): void {
    this.store.update((s) => ({
      ...s,
      transcription: { ...s.transcription, model: { ...s.transcription.model, ...p } },
    }));
  }
}

function hashFile(path: string, signal: AbortSignal): Promise<string> {
  return hashInto(createHash('sha256'), path, signal).then((h) => h.digest('hex'));
}

function hashInto(hash: Hash, path: string, signal: AbortSignal): Promise<Hash> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path, { highWaterMark: 4 * 1024 * 1024, signal });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash));
    stream.on('error', (err) => (signal.aborted ? resolve(hash) : reject(err)));
  });
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}
