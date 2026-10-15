import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecorderEvent } from '../../shared/ipc';
import type { DictationOutcome, DictationResult, DictationState, DictationStatus } from '../../shared/state';
import type { HelperProcess } from '../helper/helper-process';
import { logger } from '../log';
import type { Permissions } from '../permissions';
import type { RecorderWindow } from '../recorder-window';
import type { Store } from '../store';
import type { ShortcutListener } from './shortcuts';
import { BYTES_PER_MS, wavFile } from './wav';

// Máquina de estados del dictado:
//
//   idle → initializing → listening → stopping → processing → idle
//   cualquiera activa → idle (cancelado)
//
// Push-to-talk, con una constante de 500 ms medida desde el arranque:
// - Pulsar sin dictado activo arranca.
// - Soltar a los 500 ms o más para y guarda.
// - Soltar antes no dicta: se esperan otros 500 ms a una segunda pulsación;
//   si no llega, se descarta (un toque corto nunca produce un dictado).
// - Segunda pulsación a menos de 500 ms del arranque: manos libres; la
//   siguiente pulsación lo para. Una tercera dentro de la ventana cancela.
// - Otra tecla pulsada con fn en el primer segundo (fn + ← para ir al
//   principio, por ejemplo): no era un dictado, se descarta.
//
// El audio llega de la ventana de grabación en trozos de 40 ms (PCM de 16 bits
// a 16 kHz). Al parar se concatena y se guarda como WAV. Hasta que exista el
// historial, se conservan los últimos ficheros en `recordings/`.

const log = logger('dictation');

const DEBOUNCE_MS = 500;
const CHORD_CANCEL_MS = 1_000;
const NO_AUDIO_MS = 5_000;
const MAX_DURATION_MS = 20 * 60_000;
const WARN_DURATION_MS = 19 * 60_000;
const DONE_TIMEOUT_MS = 3_000;
const LEVEL_EVERY_MS = 150;
/** Medio segundo: menos no merece guardarse al cancelar. */
const MIN_KEEP_BYTES = 16_000;
const KEEP_RECORDINGS = 20;
/** Rango de nivel que se pinta, en dBFS. */
const LEVEL_FLOOR_DB = -60;

type CancelKind = 'user' | 'discard' | 'failure';

interface Session {
  id: string;
  startedAt: number;
  openMs: number | null;
  chunks: Buffer[];
  bytes: number;
  nextIndex: number;
  lost: number;
  pendingVolumes: number[];
  /** null mientras termina con normalidad; si no, cómo acabó. */
  outcome: DictationOutcome | null;
  reason: string;
  message: string;
  keepAudio: boolean;
  doneTimer: NodeJS.Timeout | null;
}

export class Dictation {
  private current: Session | null = null;
  /** Dictados parados o cancelados que esperan sus últimos trozos. */
  private closing = new Map<string, Session>();
  private lastActionAt = 0;
  private releaseTimer: NodeJS.Timeout | null = null;
  private noAudioTimer: NodeJS.Timeout | null = null;
  private warnTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private levelTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly helper: HelperProcess,
    private readonly recorder: RecorderWindow,
    private readonly permissions: Permissions,
    shortcuts: ShortcutListener,
    private readonly recordingsDir: string,
  ) {
    mkdirSync(recordingsDir, { recursive: true });
    shortcuts.on('down', (action) => {
      if (action === 'ptt') this.pttDown();
      else if (action === 'dismiss') this.dismiss();
    });
    shortcuts.on('up', (action) => {
      if (action === 'ptt') this.pttUp();
    });
    shortcuts.on('chord', (action) => {
      if (action === 'ptt') this.chord();
    });
    recorder.on('event', (e) => this.onRecorderEvent(e));
    recorder.on('chunk', (id, index, pcm, volume) => this.onChunk(id, index, pcm, volume));
    helper.on('ready', () => this.syncHelper());
  }

  private get state(): DictationState {
    return this.store.get().dictation;
  }

  private get active(): boolean {
    const s = this.state.status;
    return s === 'initializing' || s === 'listening';
  }

  // MARK: Atajos

  private pttDown(): void {
    const now = Date.now();
    const status = this.state.status;
    if (status === 'stopping' || status === 'processing') {
      if (now - this.lastActionAt > DEBOUNCE_MS) log.info('Ignoring shortcut: previous dictation is still finishing');
      return;
    }
    this.lastActionAt = now;
    const s = this.current;
    if (!this.active || !s) {
      this.start();
      return;
    }
    if (now - s.startedAt < DEBOUNCE_MS) {
      if (this.state.handsFree) {
        this.cancel('debounce_triple_press', 'discard', 'Cancelled by a third press.');
      } else {
        log.info(`Dictation ${short(s.id)}: pressed twice quickly → hands-free`);
        this.clearReleaseTimer();
        this.patch({ handsFree: true });
      }
      return;
    }
    if (this.state.handsFree) this.stop('hands_free_stop');
  }

  private pttUp(): void {
    const s = this.current;
    if (!this.active || !s || this.state.handsFree) return;
    const elapsed = Date.now() - s.startedAt;
    if (elapsed >= DEBOUNCE_MS) {
      if (this.state.status === 'listening') this.stop('ptt_release');
      else this.cancel('debounce_ptt', 'discard', 'The microphone took too long to start.');
      return;
    }
    // Toque corto: o llega una segunda pulsación (manos libres) o se descarta.
    this.clearReleaseTimer();
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.current === s && this.active && !this.state.handsFree) {
        log.info(`Dictation ${short(s.id)}: short tap and no second press`);
        this.cancel('debounce_ptt', 'discard', 'Too short. Hold fn while you speak.');
      }
    }, DEBOUNCE_MS);
  }

  private chord(): void {
    const s = this.current;
    if (!this.active || !s || this.state.handsFree) return;
    if (Date.now() - s.startedAt < CHORD_CANCEL_MS) {
      this.cancel('other_shortcut', 'discard', 'Another key was pressed with fn.');
    }
  }

  private dismiss(): void {
    const status = this.state.status;
    if (status === 'initializing' || status === 'listening' || status === 'stopping') {
      this.cancel('user_action_escape', 'user', 'Cancelled.');
    }
  }

  // MARK: Ciclo de vida

  private start(): void {
    if (this.helper.current.status !== 'ready') {
      this.fail('helper_not_ready', 'The Speech helper is not running.');
      return;
    }
    const mic = this.permissions.refreshMicrophone();
    if (mic !== 'granted') {
      this.fail('microphone_permission', 'Speech is not allowed to use the microphone.');
      return;
    }

    const s: Session = {
      id: randomUUID(),
      startedAt: Date.now(),
      openMs: null,
      chunks: [],
      bytes: 0,
      nextIndex: 0,
      lost: 0,
      pendingVolumes: [],
      outcome: null,
      reason: '',
      message: '',
      keepAudio: false,
      doneTimer: null,
    };
    this.current = s;
    this.setStatus('initializing', 'ptt', {
      id: s.id,
      startedAt: s.startedAt,
      handsFree: false,
      level: 0,
      micSilent: false,
    });
    this.recorder.start(s.id);

    this.noAudioTimer = setTimeout(() => {
      if (this.current === s && s.bytes === 0) {
        this.cancel('no_audio', 'failure', 'No audio arrived from the microphone.');
      }
    }, NO_AUDIO_MS);
    this.warnTimer = setTimeout(() => {
      if (this.current === s) log.warn(`Dictation ${short(s.id)}: one minute left before the time limit`);
    }, WARN_DURATION_MS);
    this.maxTimer = setTimeout(() => {
      if (this.current === s) this.stop('max_duration');
    }, MAX_DURATION_MS);
    this.levelTimer = setInterval(() => this.updateLevel(), LEVEL_EVERY_MS);
  }

  private stop(reason: string): void {
    const s = this.current;
    if (!s) return;
    this.detach(s);
    s.reason = reason;
    this.setStatus('stopping', reason, { level: 0 });
    this.awaitDone(s);
  }

  private cancel(reason: string, kind: CancelKind, message: string): void {
    const s = this.current ?? this.closingShown();
    if (!s) return;
    if (this.current === s) {
      this.detach(s);
      this.awaitDone(s);
    }
    s.outcome = kind === 'user' ? 'cancelled' : kind === 'discard' ? 'discarded' : 'failed';
    s.reason = reason;
    s.message = message;
    s.keepAudio = kind === 'user';
    this.setStatus('idle', reason, { handsFree: false, level: 0, last: this.result(s, null) });
  }

  private fail(reason: string, message: string): void {
    log.warn(`Dictation not started: ${reason}`);
    this.patch({
      last: { id: randomUUID(), outcome: 'failed', reason, message, durationMs: 0, file: null, at: Date.now() },
    });
  }

  /** Suelta el dictado activo: deja de contar como «en curso». */
  private detach(s: Session): void {
    this.current = null;
    this.clearTimers();
    this.closing.set(s.id, s);
  }

  /** Pide a la grabación que cierre y espera su «done», con plazo. */
  private awaitDone(s: Session): void {
    this.recorder.stop(s.id);
    s.doneTimer = setTimeout(() => {
      log.warn(`Dictation ${short(s.id)}: recorder did not confirm the stop; using what arrived`);
      void this.finish(s);
    }, DONE_TIMEOUT_MS);
  }

  private async finish(s: Session): Promise<void> {
    if (!this.closing.delete(s.id)) return;
    if (s.doneTimer) clearTimeout(s.doneTimer);
    const pcm = Buffer.concat(s.chunks);
    s.chunks = [];
    const durationMs = Math.round(pcm.length / BYTES_PER_MS);
    const shown = this.state.id === s.id;
    log.info(
      `Dictation ${short(s.id)}: ${durationMs} ms of audio, ${s.nextIndex} chunks, ${s.lost} lost` +
        (s.outcome ? `, ${s.outcome} (${s.reason})` : ''),
    );

    if (s.outcome) {
      // Cancelado: el resultado ya se mostró. Se guarda el audio si lo pidió el usuario.
      if (s.keepAudio && pcm.length >= MIN_KEEP_BYTES) {
        const file = await this.save(s, pcm);
        if (file && this.state.last?.id === s.id) {
          this.patch({ last: { ...this.state.last, durationMs, file } });
        }
      }
      return;
    }

    if (shown) this.setStatus('processing', 'audio complete');
    let result: DictationResult;
    if (pcm.length === 0) {
      result = { ...this.result(s, null), outcome: 'discarded', reason: 'no_audio', message: 'No audio was recorded.' };
    } else {
      const file = await this.save(s, pcm);
      result = file
        ? { ...this.result(s, file), outcome: 'saved', durationMs, message: `Saved ${(durationMs / 1000).toFixed(1)} s of audio.` }
        : { ...this.result(s, null), outcome: 'failed', reason: 'write_failed', message: 'Could not save the audio.' };
    }
    if (this.state.id === s.id) {
      this.setStatus('idle', result.reason, { handsFree: false, level: 0, last: result });
    } else {
      this.patch({ last: result });
    }
  }

  private async save(s: Session, pcm: Buffer): Promise<string | null> {
    const stamp = new Date(s.startedAt).toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const file = join(this.recordingsDir, `${stamp}-${short(s.id)}.wav`);
    try {
      await writeFile(file, wavFile(pcm));
      log.info(`Saved ${file}`);
      this.prune();
      return file;
    } catch (err) {
      log.error(`Could not write ${file}`, err);
      return null;
    }
  }

  /** Sin historial todavía: se conservan los últimos ficheros. */
  private prune(): void {
    try {
      const files = readdirSync(this.recordingsDir)
        .filter((f) => f.endsWith('.wav'))
        .sort();
      for (const f of files.slice(0, Math.max(0, files.length - KEEP_RECORDINGS))) {
        unlinkSync(join(this.recordingsDir, f));
      }
    } catch (err) {
      log.warn(`Could not prune recordings: ${(err as Error).message}`);
    }
  }

  // MARK: Grabación

  private onRecorderEvent(e: RecorderEvent): void {
    if (e.type === 'ready') return;
    const s = this.current?.id === e.id ? this.current : this.closing.get(e.id);
    if (!s) return;
    switch (e.type) {
      case 'started':
        s.openMs = e.openMs;
        log.info(`Dictation ${short(s.id)}: microphone open in ${e.openMs} ms (${e.device}, ${e.sampleRate} Hz)`);
        if (this.current === s && this.state.status === 'initializing') this.setStatus('listening', 'microphone open');
        break;
      case 'failed':
        log.error(`Dictation ${short(s.id)}: recorder failed: ${e.error}`);
        if (this.current === s) {
          this.cancel('recorder_failed', 'failure', `Could not record: ${e.error}`);
        }
        void this.finish(s);
        break;
      case 'silent':
        log.warn(`Dictation ${short(s.id)}: the microphone has sent only silence for 5 s`);
        if (this.current === s) this.patch({ micSilent: true });
        break;
      case 'done':
        void this.finish(s);
        break;
    }
  }

  private onChunk(id: string, index: number, pcm: Buffer, volume: number): void {
    const s = this.current?.id === id ? this.current : this.closing.get(id);
    if (!s) return;
    if (index > s.nextIndex) s.lost += index - s.nextIndex;
    s.nextIndex = index + 1;
    s.chunks.push(pcm);
    s.bytes += pcm.length;
    if (this.current === s) s.pendingVolumes.push(volume);
  }

  private updateLevel(): void {
    const s = this.current;
    if (!s || s.pendingVolumes.length === 0) return;
    const avg = s.pendingVolumes.reduce((a, b) => a + b, 0) / s.pendingVolumes.length;
    s.pendingVolumes = [];
    const level = Math.round(Math.min(1, Math.max(0, (avg - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB)) * 100) / 100;
    if (level !== this.state.level) this.patch({ level });
  }

  // MARK: Utilidades

  private syncHelper(): void {
    void this.helper
      .request('SetDictationActive', { active: this.state.status !== 'idle' })
      .catch((err: Error) => log.warn(`SetDictationActive failed: ${err.message}`));
  }

  private setStatus(status: DictationStatus, why: string, extra: Partial<DictationState> = {}): void {
    const prev = this.state.status;
    const id = extra.id ?? this.state.id;
    this.patch({ ...extra, status });
    log.info(`Dictation ${id ? short(id) : '-'}: ${prev} → ${status} (${why})`);
    if ((prev === 'idle') !== (status === 'idle')) this.syncHelper();
  }

  private patch(p: Partial<DictationState>): void {
    this.store.update((st) => ({ ...st, dictation: { ...st.dictation, ...p } }));
  }

  private result(s: Session, file: string | null): DictationResult {
    return {
      id: s.id,
      outcome: s.outcome ?? 'saved',
      reason: s.reason,
      message: s.message,
      durationMs: Math.round(s.bytes / BYTES_PER_MS),
      file,
      at: Date.now(),
    };
  }

  /** El dictado que la ventana muestra en «stopping», si sigue esperando trozos. */
  private closingShown(): Session | null {
    const id = this.state.id;
    return this.state.status === 'stopping' && id ? (this.closing.get(id) ?? null) : null;
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  private clearTimers(): void {
    this.clearReleaseTimer();
    for (const t of [this.noAudioTimer, this.warnTimer, this.maxTimer]) if (t) clearTimeout(t);
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.noAudioTimer = this.warnTimer = this.maxTimer = this.levelTimer = null;
  }
}

function short(id: string): string {
  return id.slice(0, 8);
}
