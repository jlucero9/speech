import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import {
  HELPER_MAX_LINE_BYTES,
  type HelperEvents,
  type HelperIncoming,
  type HelperRequests,
  type HelperRequestType,
} from '../../shared/helper-protocol';
import type { HelperState } from '../../shared/state';
import { logger } from '../log';

// Arranca el helper Swift como proceso hijo y lo mantiene vivo.
//
// - «Listo»: el helper contesta ACK a IsReady (10 s de plazo al arrancar).
// - Latido: cada 500 ms se mira cuánto hace de la última respuesta; a los 2 s
//   se envía IsReady; a los 15 s se da por colgado, se mata y se relanza.
// - Si main estuvo bloqueado o el equipo durmió (un tic llega con más de 5 s de
//   retraso), no se culpa al helper: se reinicia la cuenta.
// - Relanzado tras una muerte: 0, 1, 2, 4, 8 y 16 s. Agotados, queda en
//   'failed' hasta que se pida a mano. Tras 60 s estable, la cuenta vuelve a 0.

const log = logger('helper');

const READY_TIMEOUT_MS = 10_000;
const TICK_MS = 500;
const PING_AFTER_MS = 2_000;
const HUNG_AFTER_MS = 15_000;
const STALL_GAP_MS = 5_000;
const BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000, 16_000];
const STABLE_AFTER_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

type Pending = {
  resolve: (msg: { type: string; payload: unknown }) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export interface HelperProcessEvents {
  state: [HelperState];
  ready: [];
  event: [{ [K in keyof HelperEvents]: { type: K; payload: HelperEvents[K] } }[keyof HelperEvents]];
}

export class HelperProcess extends EventEmitter<HelperProcessEvents> {
  private child: ChildProcess | null = null;
  private stdin: Writable | null = null;
  private pending = new Map<string, Pending>();
  private state: HelperState = { status: 'starting', pid: null, restarts: 0, nextAttemptAt: null, lastError: null };
  private attempt = 0;
  private relaunchTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastResponseAt = 0;
  private lastTickAt = 0;
  private pingInFlight = false;
  private stopping = false;

  constructor(private readonly executable: string) {
    super();
  }

  get current(): HelperState {
    return this.state;
  }

  start(): void {
    this.stopping = false;
    this.launch();
    if (!this.tickTimer) {
      this.lastTickAt = Date.now();
      this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    }
  }

  /** Relanzado manual tras 'failed'. */
  retry(): void {
    if (this.state.status !== 'failed') return;
    this.attempt = 0;
    this.setState({ restarts: 0, lastError: null });
    this.start();
  }

  /** El equipo volvió de reposo: el silencio del helper no es culpa suya. */
  noteResume(): void {
    this.lastResponseAt = Date.now();
    this.lastTickAt = Date.now();
  }

  stop(): void {
    this.stopping = true;
    this.clearTimers();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.setState({ status: 'stopped', nextAttemptAt: null });
    this.child?.kill('SIGTERM');
  }

  request<T extends HelperRequestType>(
    type: T,
    payload: HelperRequests[T]['payload'] = {} as HelperRequests[T]['payload'],
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<HelperRequests[T]['response']> {
    const stdin = this.stdin;
    if (!stdin || !this.child || this.child.exitCode !== null) {
      return Promise.reject(new Error(`Helper not running (${type})`));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Helper request ${type} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (msg) => {
          if (msg.type === 'Error') {
            reject(new Error(`Helper error for ${type}: ${(msg.payload as { message?: string })?.message}`));
          } else {
            resolve(msg as HelperRequests[T]['response']);
          }
        },
        reject,
        timer,
      });
      stdin.write(JSON.stringify({ kind: 'request', id, type, payload }) + '\n');
    });
  }

  private launch(): void {
    this.relaunchTimer = null;
    this.setState({ status: 'starting', pid: null, nextAttemptAt: null });
    log.info(`Launching ${this.executable}`);

    let child: ChildProcess;
    try {
      child = spawn(this.executable, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '' },
      });
    } catch (err) {
      this.onExit(null, null, `spawn failed: ${(err as Error).message}`);
      return;
    }
    this.child = child;
    this.stdin = child.stdin;
    this.lastResponseAt = Date.now();

    child.on('error', (err) => {
      // ENOENT, EACCES…: el proceso ni siquiera arrancó.
      log.error('Helper process error', err);
      if (this.child === child) this.onExit(null, null, err.message);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.onExit(code, signal, null);
    });
    child.stdin?.on('error', (err) => log.warn('Helper stdin error', err.message));

    pipeLog(child.stdout, 'stdout');
    pipeLog(child.stderr, 'stderr');
    this.readMessages(child.stdio[3] as Readable);

    if (child.pid) this.setState({ pid: child.pid });

    this.request('IsReady', {}, READY_TIMEOUT_MS)
      .then((ack) => {
        if (this.child !== child) return;
        log.info(`Helper ready: pid ${ack.payload.pid}, launch ${ack.payload.launchMs} ms, disclaimed ${ack.payload.disclaimed}`);
        this.setState({ status: 'ready', lastError: null });
        this.stableTimer = setTimeout(() => {
          this.attempt = 0;
          this.setState({ restarts: 0 });
        }, STABLE_AFTER_MS);
        this.emit('ready');
      })
      .catch((err: Error) => {
        if (this.child !== child) return;
        log.error(`Helper did not become ready: ${err.message}`);
        this.setState({ lastError: 'The helper did not respond after launch.' });
        child.kill('SIGKILL');
      });
  }

  private readMessages(stream: Readable): void {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.handleLine(line);
      }
      if (buffer.length > HELPER_MAX_LINE_BYTES) {
        log.error(`Discarding oversized helper message (${buffer.length} bytes)`);
        buffer = '';
      }
    });
  }

  private handleLine(line: string): void {
    let msg: HelperIncoming;
    try {
      msg = JSON.parse(line) as HelperIncoming;
    } catch {
      log.warn(`Unparseable helper message: ${line.slice(0, 200)}`);
      return;
    }
    this.lastResponseAt = Date.now();
    if (msg.kind === 'response') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    } else if (msg.kind === 'event') {
      this.emit('event', { type: msg.type, payload: msg.payload });
    }
  }

  private tick(): void {
    const now = Date.now();
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap > STALL_GAP_MS) {
      log.warn(`Main was stalled for ${gap} ms; not blaming the helper`);
      this.lastResponseAt = now;
      return;
    }
    if (this.state.status !== 'ready' || !this.child) return;

    const silence = now - this.lastResponseAt;
    if (silence >= HUNG_AFTER_MS) {
      log.error(`Helper silent for ${silence} ms, killing it`);
      this.setState({ lastError: 'The helper stopped responding.' });
      this.child.kill('SIGKILL');
    } else if (silence >= PING_AFTER_MS && !this.pingInFlight) {
      this.pingInFlight = true;
      this.request('IsReady', {}, HUNG_AFTER_MS)
        .catch(() => {
          // El latido decide; aquí solo se evita otra petición en vuelo.
        })
        .finally(() => {
          this.pingInFlight = false;
        });
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, error: string | null): void {
    const how = error ?? (signal ? `signal ${signal}` : `code ${code}`);
    this.child = null;
    this.stdin = null;
    this.pingInFlight = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Helper exited (${how})`));
      this.pending.delete(id);
    }
    this.clearTimers();

    if (this.stopping) {
      log.info(`Helper exited on shutdown (${how})`);
      return;
    }
    log.warn(`Helper exited unexpectedly (${how})`);

    if (this.attempt >= BACKOFF_MS.length) {
      log.error(`Helper failed ${this.attempt} times in a row; giving up until asked to retry`);
      this.setState({
        status: 'failed',
        pid: null,
        nextAttemptAt: null,
        lastError: this.state.lastError ?? `The helper keeps quitting (${how}).`,
      });
      return;
    }
    const delay = BACKOFF_MS[this.attempt];
    this.attempt++;
    this.setState({
      status: 'restarting',
      pid: null,
      restarts: this.state.restarts + 1,
      nextAttemptAt: Date.now() + delay,
      lastError: this.state.lastError ?? `The helper quit (${how}).`,
    });
    log.info(`Relaunching helper in ${delay} ms (attempt ${this.attempt} of ${BACKOFF_MS.length})`);
    this.relaunchTimer = setTimeout(() => this.launch(), delay);
  }

  private clearTimers(): void {
    if (this.relaunchTimer) clearTimeout(this.relaunchTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.relaunchTimer = null;
    this.stableTimer = null;
  }

  private setState(patch: Partial<HelperState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }
}

function pipeLog(stream: Readable | null, name: string): void {
  if (!stream) return;
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) log.info(`(${name}) ${line}`);
    }
  });
}
