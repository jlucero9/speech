import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PasteTargetInfo } from '../../shared/helper-protocol';
import type { RecorderEvent } from '../../shared/ipc';
import type { DictationOutcome, DictationResult, DictationState, DictationStatus, PasteInfo } from '../../shared/state';
import type { HelperProcess } from '../helper/helper-process';
import type { History } from '../history';
import { logger } from '../log';
import type { Permissions } from '../permissions';
import type { RecorderWindow } from '../recorder-window';
import type { Store } from '../store';
import { TranscriptionError, type TranscriptionEngine } from '../transcription/engine';
import type { PasteOutcome, Paster } from './paste';
import type { ShortcutListener } from './shortcuts';
import { checkVoice, MIN_SPEECH_MS } from './voice';
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
// a 16 kHz). Al parar se concatena, se guarda como WAV en `recordings/`, se
// anota en el historial, se transcribe y se pega. Al empezar a dictar se avisa
// al motor para que cargue el modelo mientras el usuario habla, y al helper
// para que anote dónde está el foco: el texto se pega ahí aunque el usuario
// cambie de app mientras se transcribe. El dictado vuelve a «idle» al enviar
// el ⌘V; el resultado del pegado llega después y completa la fila.

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
  /** App y campo con foco al empezar; se resuelve enseguida. */
  target: Promise<PasteTargetInfo | null>;
  /** Hora a la que se soltó la tecla (o se paró de otro modo). */
  stoppedAt: number | null;
  /** Hora a la que llegó todo el audio. */
  audioAt: number | null;
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
  /** Transcripción en curso, para poder cancelarla con Esc. */
  private transcribing: { id: string; abort: AbortController } | null = null;

  constructor(
    private readonly store: Store,
    private readonly helper: HelperProcess,
    private readonly recorder: RecorderWindow,
    private readonly permissions: Permissions,
    shortcuts: ShortcutListener,
    private readonly recordingsDir: string,
    private readonly engine: TranscriptionEngine,
    private readonly history: History | null,
    private readonly vocabulary: () => string[],
    private readonly paster: Paster,
  ) {
    mkdirSync(recordingsDir, { recursive: true });
    shortcuts.on('down', (action) => {
      if (action === 'ptt') this.pttDown();
      else if (action === 'dismiss') this.dismiss();
    });
    shortcuts.on('up', (action) => {
      if (action === 'ptt') this.pttUp();
      else if (action === 'paste_last') this.pasteLast();
      else if (action === 'copy_last') this.copyLast();
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
    } else if (status === 'processing' && this.transcribing?.id === this.state.id) {
      log.info(`Dictation ${short(this.transcribing.id)}: transcription cancelled with Esc`);
      this.transcribing.abort.abort();
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

    const randomId = randomUUID();
    const s: Session = {
      id: randomId,
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
      target: this.paster.captureTarget(randomId),
      stoppedAt: null,
      audioAt: null,
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
    this.engine.prepare(this.store.get().prefs.dictationLanguage);

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
    s.stoppedAt = Date.now();
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
    this.patch({ last: { ...emptyResult(randomUUID()), outcome: 'failed', reason, message } });
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
    s.audioAt = Date.now();
    const pcm = Buffer.concat(s.chunks);
    s.chunks = [];
    const durationMs = Math.round(pcm.length / BYTES_PER_MS);
    const shown = this.state.id === s.id;
    log.info(
      `Dictation ${short(s.id)}: ${durationMs} ms of audio, ${s.nextIndex} chunks, ${s.lost} lost` +
        (s.outcome ? `, ${s.outcome} (${s.reason})` : ''),
    );

    if (s.outcome) {
      // Cancelado: el resultado ya se mostró. Si lo canceló el usuario, el audio
      // se guarda en el historial para poder recuperarlo.
      if (s.keepAudio && pcm.length >= MIN_KEEP_BYTES) {
        const file = await this.save(s, pcm);
        if (file) this.record(s, durationMs, file, 'cancelled', { error: `${s.reason}: ${s.message}` });
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
        ? await this.transcribe(s, file, pcm, durationMs)
        : { ...this.result(s, null), outcome: 'failed', reason: 'write_failed', message: 'Could not save the audio.' };
      if (result.outcome === 'done') result = await this.paste(s, result);
    }
    if (this.state.id === s.id) {
      this.setStatus('idle', result.reason, { handsFree: false, level: 0, last: result });
    } else {
      this.patch({ last: result });
    }
  }

  private async transcribe(s: Session, file: string, pcm: Buffer, durationMs: number): Promise<DictationResult> {
    const language = this.store.get().prefs.dictationLanguage;
    this.record(s, durationMs, file, 'processing', { language });
    const voice = checkVoice(pcm);
    if (voice.speechMs < MIN_SPEECH_MS) {
      // Sin voz, whisper se inventaría una frase: ni se transcribe ni se pega.
      log.info(
        `Dictation ${short(s.id)}: no speech (${voice.speechMs} ms above the threshold, ` +
          `floor ${voice.floorDb.toFixed(0)} dBFS, peak ${voice.peakDb.toFixed(0)} dBFS); not transcribing`,
      );
      this.updateHistory(s.id, { status: 'done', asrText: '' });
      return {
        ...this.result(s, file),
        durationMs,
        outcome: 'done',
        reason: 'no_speech',
        message: 'No speech detected.',
        text: '',
        language,
      };
    }
    const abort = new AbortController();
    this.transcribing = { id: s.id, abort };
    const base = { ...this.result(s, file), durationMs };
    try {
      const r = await this.engine.transcribe({
        id: s.id,
        audioPath: file,
        durationMs,
        language,
        vocabulary: this.vocabulary(),
        signal: abort.signal,
      });
      this.updateHistory(s.id, {
        status: 'done',
        asrText: r.text,
        language: r.language,
        engine: r.engine,
        model: r.model,
        transcriptionMs: r.ms,
      });
      return {
        ...base,
        outcome: 'done',
        reason: 'transcribed',
        message: r.text ? `Transcribed in ${(r.ms / 1000).toFixed(1)} s.` : 'No speech detected.',
        text: r.text,
        language: r.language,
        transcriptionMs: r.ms,
      };
    } catch (err) {
      const e = err instanceof TranscriptionError ? err : new TranscriptionError('engine_failed', (err as Error).message);
      const cancelled = e.code === 'cancelled';
      if (!cancelled) log.error(`Dictation ${short(s.id)}: transcription failed (${e.code}): ${e.message}`);
      this.updateHistory(s.id, { status: cancelled ? 'cancelled' : 'failed', engine: this.engine.id, error: `${e.code}: ${e.message}` });
      return {
        ...base,
        outcome: cancelled ? 'cancelled' : 'failed',
        reason: cancelled ? 'user_action_escape' : `transcription_${e.code}`,
        message: cancelled ? 'Cancelled. The audio is kept in your history.' : `${e.message} The audio is kept in your history.`,
      };
    } finally {
      if (this.transcribing?.abort === abort) this.transcribing = null;
    }
  }

  // MARK: Pegado

  private async paste(s: Session, r: DictationResult): Promise<DictationResult> {
    const text = r.text ?? '';
    if (!text.trim()) {
      log.info(`Dictation ${short(s.id)}: nothing to paste`);
      this.updateHistory(s.id, { pasteResult: 'empty' });
      return { ...r, paste: { result: 'empty', appName: null, ms: null } };
    }
    const target = await s.target;
    const sentAt = Date.now();
    this.updateHistory(s.id, {
      pastedText: text,
      appName: target?.appName ?? null,
      appBundleId: target?.bundleId ?? null,
    });
    const job = this.paster.paste(s.id, text, target ? s.id : null);
    // Si no se llega a enviar el ⌘V, el resultado llega antes que la respuesta.
    let settled: PasteInfo | null = null;
    void job.outcome.then((o) => {
      settled = this.pasted(s, sentAt, o);
    });
    await job.posted;
    return { ...r, paste: settled ?? { result: 'pending', appName: target?.appName ?? null, ms: null } };
  }

  /** Resultado del pegado: completa la fila y, si se ve, el último dictado. */
  private pasted(s: Session, sentAt: number, o: PasteOutcome): PasteInfo {
    const released = s.stoppedAt ?? sentAt;
    const ms = o.requestedMs != null ? sentAt - released + o.requestedMs : null;
    const steps = [
      s.audioAt != null ? `audio ${s.audioAt - released} ms` : null,
      s.audioAt != null ? `transcription and saving ${sentAt - s.audioAt} ms` : null,
      o.keystrokeMs != null ? `⌘V ${o.keystrokeMs} ms` : null,
      o.requestedMs != null && o.keystrokeMs != null ? `read ${o.requestedMs - o.keystrokeMs} ms after ⌘V` : null,
    ].filter(Boolean);
    log.info(
      `Dictation ${short(s.id)}: paste ${o.result} in ${o.appName ?? '?'}` +
        (ms != null ? `, text in the app ${ms} ms after release` : '') +
        (steps.length ? ` (${steps.join(', ')})` : '') +
        (o.detail ? `; ${o.detail}` : ''),
    );
    this.updateHistory(s.id, {
      pasteResult: o.result,
      pasteMs: ms,
      ...(o.appName ? { appName: o.appName, appBundleId: o.bundleId } : {}),
    });
    const info: PasteInfo = { result: o.result, appName: o.appName, ms };
    const last = this.state.last;
    if (last?.id === s.id) this.patch({ last: { ...last, paste: { ...info, appName: o.appName ?? last.paste?.appName ?? null } } });
    return info;
  }

  /** Atajo «pegar el último dictado»: donde esté el foco ahora. */
  private pasteLast(): void {
    const text = this.lastText();
    if (!text) {
      log.info('Paste last: no dictation to paste');
      return;
    }
    const id = randomUUID();
    log.info(`Paste last: pasting ${text.length} chars (${short(id)})`);
    const job = this.paster.paste(id, text, null);
    void job.outcome.then((o) => log.info(`Paste last ${short(id)}: ${o.result} in ${o.appName ?? '?'}`));
  }

  private copyLast(): void {
    const text = this.lastText();
    if (!text) {
      log.info('Copy last: no dictation to copy');
      return;
    }
    this.paster.copy(text);
    log.info(`Copy last: ${text.length} chars on the clipboard`);
  }

  private lastText(): string | null {
    const last = this.state.last;
    if (last?.outcome === 'done' && last.text?.trim()) return last.text;
    try {
      return this.history?.lastText() ?? null;
    } catch (err) {
      log.warn(`Could not read the last dictation: ${(err as Error).message}`);
      return null;
    }
  }

  private async save(s: Session, pcm: Buffer): Promise<string | null> {
    const stamp = new Date(s.startedAt).toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const file = join(this.recordingsDir, `${stamp}-${short(s.id)}.wav`);
    try {
      await writeFile(file, wavFile(pcm));
      log.info(`Saved ${file}`);
      return file;
    } catch (err) {
      log.error(`Could not write ${file}`, err);
      return null;
    }
  }

  // MARK: Historial

  private record(
    s: Session,
    durationMs: number,
    file: string,
    status: 'processing' | 'cancelled',
    extra: { language?: string | null; error?: string },
  ): void {
    if (!this.history) return;
    try {
      this.history.insert({
        id: s.id,
        createdAt: s.startedAt,
        status,
        durationMs,
        audioPath: file,
        language: extra.language ?? null,
      });
      if (extra.error) this.history.update(s.id, { error: extra.error });
    } catch (err) {
      log.error(`Could not add dictation ${short(s.id)} to the history`, err);
    }
  }

  private updateHistory(id: string, u: Parameters<History['update']>[1]): void {
    try {
      this.history?.update(id, u);
    } catch (err) {
      log.error(`Could not update dictation ${short(id)} in the history`, err);
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
      ...emptyResult(s.id),
      outcome: s.outcome ?? 'done',
      reason: s.reason,
      message: s.message,
      durationMs: Math.round(s.bytes / BYTES_PER_MS),
      file,
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

function emptyResult(id: string): DictationResult {
  return {
    id,
    outcome: 'failed',
    reason: '',
    message: '',
    durationMs: 0,
    file: null,
    text: null,
    language: null,
    transcriptionMs: null,
    paste: null,
    at: Date.now(),
  };
}

function short(id: string): string {
  return id.slice(0, 8);
}
