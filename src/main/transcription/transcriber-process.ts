import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { logger } from '../log';
import {
  TRANSCRIBER_PROTOCOL,
  type TranscriberCommand,
  type TranscriberMessage,
} from './transcriber-protocol';

// Un proceso SpeechTranscriber: lo lanza, espera su «hello» y empareja cada
// orden con su respuesta. No decide cuándo vive o muere: eso es de LocalWhisper.

const log = logger('transcriber');

const HELLO_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;

type Reply = Exclude<TranscriberMessage, { type: 'hello' }>;
type Command = TranscriberCommand extends infer C ? (C extends { id: string } ? Omit<C, 'id'> : never) : never;

export class TranscriberProcessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ProcessEvents {
  exit: [code: number | null, signal: NodeJS.Signals | null];
}

export class TranscriberProcess extends EventEmitter<ProcessEvents> {
  readonly ready: Promise<void>;
  private proc: ChildProcess;
  private pending = new Map<string, { resolve: (m: Reply) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private exited = false;

  constructor(executable: string) {
    super();
    const proc = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let onHello: () => void = () => {};
    let onFail: (e: Error) => void = () => {};
    this.ready = new Promise<void>((resolve, reject) => {
      onHello = resolve;
      onFail = reject;
    });
    // Quien crea el proceso espera `ready`; esto evita el aviso de promesa sin atender si muere antes.
    this.ready.catch(() => {});
    const helloTimer = setTimeout(() => {
      onFail(new TranscriberProcessError('engine_failed', 'The transcriber did not start in time'));
      this.kill();
    }, HELLO_TIMEOUT_MS);

    createInterface({ input: proc.stdout! }).on('line', (line) => {
      let msg: TranscriberMessage;
      try {
        msg = JSON.parse(line) as TranscriberMessage;
      } catch {
        log.warn(`Unreadable line from the transcriber: ${line.slice(0, 200)}`);
        return;
      }
      if (msg.type === 'hello') {
        clearTimeout(helloTimer);
        if (msg.protocol !== TRANSCRIBER_PROTOCOL) {
          onFail(new TranscriberProcessError('engine_failed', `Transcriber protocol ${msg.protocol}, expected ${TRANSCRIBER_PROTOCOL}`));
          this.kill();
          return;
        }
        log.info(`Transcriber started (pid ${msg.pid}, whisper.cpp ${msg.whisper})`);
        onHello();
        return;
      }
      const waiting = this.pending.get(msg.id);
      if (!waiting) {
        if (msg.type === 'error') log.warn(`Transcriber error without a request: ${msg.code}: ${msg.message}`);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error') waiting.reject(new TranscriberProcessError(msg.code, msg.message));
      else waiting.resolve(msg);
    });
    createInterface({ input: proc.stderr! }).on('line', (line) => {
      if (line.trim()) log.info(`[whisper] ${line}`);
    });

    proc.on('error', (err) => {
      clearTimeout(helloTimer);
      onFail(new TranscriberProcessError('engine_failed', `Could not start the transcriber: ${err.message}`));
      this.onExit(null, null);
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(helloTimer);
      onFail(new TranscriberProcessError('engine_failed', `The transcriber quit (${signal ?? `code ${code}`})`));
      this.onExit(code, signal);
    });
    // Si main escribe cuando el proceso ya murió, el error llega aquí y no debe tumbar la app.
    proc.stdin!.on('error', () => {});
  }

  get pid(): number | null {
    return this.proc.pid ?? null;
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Envía una orden y espera su respuesta. Devuelve también el id, para cancelar. */
  request<T extends Reply['type']>(cmd: Command): { id: string; reply: Promise<Extract<Reply, { type: T }>> } {
    const id = String(this.nextId++);
    const reply = new Promise<Reply>((resolve, reject) => {
      if (this.exited) {
        reject(new TranscriberProcessError('engine_failed', 'The transcriber is not running'));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.proc.stdin!.write(JSON.stringify({ ...cmd, id }) + '\n');
    });
    return { id, reply: reply as Promise<Extract<Reply, { type: T }>> };
  }

  /** Orden sin respuesta (cancel). */
  notify(cmd: TranscriberCommand): void {
    if (!this.exited) this.proc.stdin!.write(JSON.stringify(cmd) + '\n');
  }

  /** Cierra stdin (el proceso sale solo) y, si no sale, lo mata. */
  stop(): void {
    if (this.exited) return;
    this.proc.stdin!.end();
    setTimeout(() => this.kill(), KILL_GRACE_MS).unref();
  }

  kill(): void {
    if (!this.exited) this.proc.kill('SIGKILL');
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const p of this.pending.values()) {
      p.reject(new TranscriberProcessError('engine_failed', `The transcriber quit (${signal ?? `code ${code}`})`));
    }
    this.pending.clear();
    this.emit('exit', code, signal);
  }
}
