import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BarSound } from '../../shared/bar';
import type { PasteTargetInfo } from '../../shared/helper-protocol';
import type { HistoryActionResult } from '../../shared/history';
import type { DictationOutcome, DictationResult, DictationState, DictationStatus, FormatInfo, PasteInfo } from '../../shared/state';
import { notice } from '../bar/notice-texts';
import type { NewNotice } from '../bar/notices';
import { FormatError } from '../formatting/formatter';
import type { TextFormatting } from '../formatting/service';
import { fitToSurroundings } from '../formatting/surroundings';
import type { HelperProcess } from '../helper/helper-process';
import type { History } from '../history';
import { logger } from '../log';
import type { Permissions } from '../permissions';
import type { RecorderWindow, RecordingEvent } from '../recorder-window';
import type { Store } from '../store';
import { TranscriptionError, type TranscriptionEngine } from '../transcription/engine';
import { isPasteFailure, type PasteOutcome, type Paster } from './paste';
import type { ShortcutListener } from './shortcuts';
import type { Substituted } from './substitutions';
import { checkVoice, MIN_SPEECH_MS, type VoiceLevels } from './voice';
import { BYTES_PER_MS, WAV_HEADER_BYTES, wavFile } from './wav';

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
//
// Manos libres también con su atajo (fn + Espacio) y con la barra:
// - Sin dictado, arranca en manos libres.
// - Con un push-to-talk en curso, lo convierte sin reiniciarlo.
// - En manos libres, para si han pasado 500 ms desde el arranque y, si no,
//   cancela (la barra siempre para).
// - Otra tecla pulsada con fn en el primer segundo (fn + ← para ir al
//   principio, por ejemplo): no era un dictado, se descarta.
//
// El audio llega de la ventana de grabación en trozos de 40 ms (PCM de 16 bits
// a 16 kHz). Al parar se concatena, se guarda como WAV en `recordings/`, se
// anota en el historial, se transcribe, se formatea y se pega. Al empezar a
// dictar se avisa a los dos modelos (transcripción y formateo) para que carguen
// mientras el usuario habla, y al helper para que anote dónde está el foco y
// qué texto lo rodea: el texto se pega ahí aunque el usuario cambie de app
// mientras se procesa, con los espacios que pida lo que ya hay escrito. El dictado vuelve a «idle» al enviar
// el ⌘V; el resultado del pegado llega después y completa la fila.
//
// Lo que el usuario debe saber (no se pudo pegar, se pegó sin formato, falta
// el micrófono o el modelo…) se avisa en la barra, con su sonido.

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
/** El sonido de empezar dura ~0,2 s: se silencia la salida después. */
const MUTE_AFTER_MS = 300;

type CancelKind = 'user' | 'discard' | 'failure';

/** Lo que el dictado cuenta a la barra: sonidos y avisos. */
export interface DictationFeedback {
  sound(sound: BarSound): void;
  notify(n: NewNotice): void;
  /** Cierra el aviso que se ve, sea cual sea. */
  clearNotice(): void;
  /** Al empezar a dictar: la barra pasa a la pantalla donde está el cursor. */
  followCursor(): void;
  /** Atajo de dictar, para los textos («fn»). */
  pttLabel(): string;
  /** Un dictado terminó (para el historial que no se guarda). */
  concluded(id: string, outcome: DictationOutcome): void;
  /** Con qué micrófono se grabó. */
  microphoneUsed(label: string): void;
}

/** Lo que el dictado usa del diccionario; se lee en cada dictado. */
export interface DictationWords {
  /** Términos para las pistas del motor y del formateo. */
  terms(): string[];
  /** Palabras que se escriben tal cual (no se pasan a minúscula al continuar una frase). */
  spellings(): string[];
  substitute(text: string): Substituted;
}

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
  /** Dictado que se vuelve a transcribir desde su audio («Undo» o el Hub): la fila ya existe. */
  recovered: boolean;
  /** Reintento desde el Hub: no se ve en la barra y Esc no lo cancela. */
  background: boolean;
  /** Horas a las que sonó la app durante la grabación (el micrófono los recoge). */
  soundsAt: number[];
  /** Micrófono con el que se grabó, por su nombre; null si no se sabe. */
  device: string | null;
}

export class Dictation {
  private current: Session | null = null;
  /** Dictados parados o cancelados que esperan sus últimos trozos. */
  private closing = new Map<string, Session>();
  private lastActionAt = 0;
  /** Último aviso de «aún procesando». */
  private lastBusyAt = 0;
  /**
   * La pulsación de fn en curso terminó un dictado en manos libres: el
   * Espacio de fn + Espacio que llega después no debe empezar otro.
   */
  private pressEndedDictation = false;
  private releaseTimer: NodeJS.Timeout | null = null;
  private noAudioTimer: NodeJS.Timeout | null = null;
  private warnTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;
  private levelTimer: NodeJS.Timeout | null = null;
  /** Transcripción o formateo en curso, para poder cancelarlos con Esc. */
  private transcribing: { id: string; abort: AbortController } | null = null;
  /** Filas que se están reintentando desde el Hub. */
  private retrying = new Set<string>();
  private muteTimer: NodeJS.Timeout | null = null;
  /** La salida está silenciada por un dictado. */
  private muted = false;

  constructor(
    private readonly store: Store,
    private readonly helper: HelperProcess,
    private readonly recorder: RecorderWindow,
    private readonly permissions: Permissions,
    shortcuts: ShortcutListener,
    private readonly recordingsDir: string,
    private readonly engine: TranscriptionEngine,
    private readonly history: History | null,
    private readonly words: DictationWords,
    private readonly paster: Paster,
    private readonly formatting: TextFormatting,
    private readonly feedback: DictationFeedback,
    private readonly voiceLevels: VoiceLevels,
  ) {
    mkdirSync(recordingsDir, { recursive: true });
    shortcuts.on('down', (action) => {
      if (action === 'ptt') this.pttDown();
      else if (action === 'hands_free') this.handsFreeToggle('shortcut');
      else if (action === 'dismiss') this.dismiss();
    });
    shortcuts.on('up', (action) => {
      if (action === 'ptt' || action === 'hands_free') this.pressEndedDictation = false;
      if (action === 'ptt') this.pttUp();
      else if (action === 'paste_last') this.pasteLast();
      else if (action === 'copy_last') this.copyLast();
    });
    shortcuts.on('chord', (action) => {
      if (action === 'ptt') this.chord();
    });
    recorder.on('event', (e) => this.onRecorderEvent(e));
    recorder.on('chunk', (id, index, pcm, volume) => this.onChunk(id, index, pcm, volume));
    helper.on('ready', () => {
      this.syncHelper();
      // Un helper relanzado ya devolvió el sonido que dejó silenciado el
      // anterior; si se sigue dictando, se vuelve a silenciar.
      if (this.muted) {
        this.muted = false;
        if (this.current && this.store.get().prefs.muteWhileDictating) this.setMuted(true);
      }
    });
  }

  private get state(): DictationState {
    return this.store.get().dictation;
  }

  /** Hay un dictado grabando o terminando. */
  get inProgress(): boolean {
    return this.state.status !== 'idle';
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
      this.busy(now);
      return;
    }
    this.lastActionAt = now;
    this.pressEndedDictation = false;
    const s = this.current;
    if (!this.active || !s) {
      this.start(false);
      return;
    }
    if (now - s.startedAt < DEBOUNCE_MS) {
      if (this.state.handsFree) {
        this.pressEndedDictation = true;
        this.cancel('debounce_triple_press', 'discard', 'Cancelled by a third press.');
      } else {
        log.info(`Dictation ${short(s.id)}: pressed twice quickly → hands-free`);
        this.lock();
      }
      return;
    }
    if (this.state.handsFree) {
      this.pressEndedDictation = true;
      this.stop('hands_free_stop');
    }
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
        this.cancel('debounce_ptt', 'discard', `Too short. Hold ${this.feedback.pttLabel()} while you speak.`);
        this.feedback.notify(notice.shortTap());
      }
    }, DEBOUNCE_MS);
  }

  private chord(): void {
    const s = this.current;
    if (!this.active || !s || this.state.handsFree) return;
    if (Date.now() - s.startedAt < CHORD_CANCEL_MS) {
      this.cancel('other_shortcut', 'discard', `Another key was pressed with ${this.feedback.pttLabel()}.`);
    }
  }

  /** Atajo de manos libres o botones de la barra. */
  private handsFreeToggle(source: 'shortcut' | 'bar'): void {
    const now = Date.now();
    if (source === 'shortcut' && this.pressEndedDictation) {
      log.info('Ignoring hands-free shortcut: its fn press already ended the dictation');
      return;
    }
    const status = this.state.status;
    if (status === 'stopping' || status === 'processing') {
      this.busy(now);
      return;
    }
    this.lastActionAt = now;
    const s = this.current;
    if (!this.active || !s) {
      this.start(true);
      return;
    }
    if (!this.state.handsFree) {
      log.info(`Dictation ${short(s.id)}: hands-free ${source} while holding → hands-free`);
      this.lock();
      return;
    }
    if (source === 'bar' || now - s.startedAt >= DEBOUNCE_MS) this.stop('hands_free_stop');
    else this.cancel('debounce_popo', 'discard', 'Started and stopped too quickly.');
  }

  /** Pasa el dictado en curso a manos libres. */
  private lock(): void {
    this.clearReleaseTimer();
    this.patch({ handsFree: true });
    if (this.current) this.sound(this.current, 'lock');
  }

  /** Un sonido durante la grabación: se anota para que no cuente como voz. */
  private sound(s: Session, sound: BarSound): void {
    this.feedback.sound(sound);
    if (this.store.get().prefs.enableSounds) s.soundsAt.push(Date.now());
  }

  /** Se pulsó el atajo con el dictado anterior aún terminando. */
  private busy(now: number): void {
    // fn + Espacio son dos pulsaciones: un solo aviso.
    if (now - this.lastActionAt <= DEBOUNCE_MS || now - this.lastBusyAt <= DEBOUNCE_MS) return;
    this.lastBusyAt = now;
    log.info('Ignoring shortcut: previous dictation is still finishing');
    this.feedback.notify(notice.busy());
  }

  // MARK: Barra

  /** Clic en la píldora en reposo: dictado en manos libres. */
  startFromBar(): void {
    if (this.state.status === 'idle') this.handsFreeToggle('bar');
  }

  stopFromBar(): void {
    if (this.active && this.state.handsFree) this.handsFreeToggle('bar');
  }

  cancelFromBar(): void {
    if (this.active || this.state.status === 'stopping') this.cancel('user_action_cancel_button', 'user', 'Cancelled.');
  }

  private dismiss(): void {
    const status = this.state.status;
    if (status === 'initializing' || status === 'listening' || status === 'stopping') {
      this.cancel('user_action_escape', 'user', 'Cancelled.');
    } else if (status === 'processing' && this.transcribing?.id === this.state.id) {
      log.info(`Dictation ${short(this.transcribing.id)}: processing cancelled with Esc`);
      this.transcribing.abort.abort();
    }
  }

  // MARK: Ciclo de vida

  private start(handsFree: boolean): void {
    this.feedback.clearNotice();
    if (this.helper.current.status !== 'ready') {
      this.fail('helper_not_ready', 'The Speech helper is not running.', notice.helperNotReady());
      return;
    }
    const mic = this.permissions.refreshMicrophone();
    if (mic !== 'granted') {
      this.fail('microphone_permission', 'Speech is not allowed to use the microphone.', notice.microphonePermission());
      return;
    }
    const model = this.store.get().transcription.model;
    // Con un motor en la nube, el modelo local no hace falta.
    if (this.store.get().prefs.transcriptionEngine === 'local' && model.status !== 'ready') {
      this.fail('model_not_ready', `The speech model is not ready (${model.status}).`, notice.modelNotReady(model));
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
      target: this.paster.captureTarget(randomId, this.store.get().prefs.contextAwareness),
      stoppedAt: null,
      audioAt: null,
      recovered: false,
      background: false,
      soundsAt: [],
      device: null,
    };
    this.current = s;
    this.feedback.followCursor();
    this.setStatus('initializing', handsFree ? 'hands-free' : 'ptt', {
      id: s.id,
      startedAt: s.startedAt,
      handsFree,
      level: 0,
      micSilent: false,
    });
    this.sound(s, handsFree ? 'lock' : 'start');
    const prefs = this.store.get().prefs;
    this.recorder.start(s.id, prefs.microphoneId ? { id: prefs.microphoneId, label: prefs.microphoneLabel } : null);
    if (prefs.muteWhileDictating) {
      this.muteTimer = setTimeout(() => {
        this.muteTimer = null;
        if (this.current === s) this.setMuted(true);
      }, MUTE_AFTER_MS);
    }
    this.engine.prepare(this.store.get().prefs.dictationLanguage);
    this.formatting.prepare();

    this.noAudioTimer = setTimeout(() => {
      if (this.current === s && s.bytes === 0) {
        this.cancel('no_audio', 'failure', 'No audio arrived from the microphone.');
      }
    }, NO_AUDIO_MS);
    this.warnTimer = setTimeout(() => {
      if (this.current !== s) return;
      log.warn(`Dictation ${short(s.id)}: one minute left before the time limit`);
      this.feedback.notify(notice.durationWarning());
    }, WARN_DURATION_MS);
    this.maxTimer = setTimeout(() => {
      if (this.current !== s) return;
      this.stop('max_duration');
      this.feedback.notify(notice.maxDuration());
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

  /**
   * El equipo se va a dormir. Una grabación en marcha se para y su audio queda
   * en el historial, sin transcribir ni pegar: al despertar, el foco puede
   * estar en cualquier sitio. El aviso permite recuperarlo.
   */
  systemWillSleep(): void {
    if (!this.active || !this.current) return;
    const id = this.current.id;
    this.cancel('system_sleep', 'user', 'Stopped when your Mac went to sleep.', notice.sleepStopped(id));
  }

  private cancel(reason: string, kind: CancelKind, message: string, n?: NewNotice): void {
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
    if (n) this.feedback.notify(n);
    else if (kind === 'user') this.feedback.notify(notice.cancelled(s.id));
    else if (kind === 'failure') this.feedback.notify(notice.recordingFailed(message, s.id));
  }

  private fail(reason: string, message: string, n: NewNotice): void {
    log.warn(`Dictation not started: ${reason}`);
    this.patch({ last: { ...emptyResult(randomUUID()), outcome: 'failed', reason, message } });
    this.feedback.notify(n);
  }

  /** Suelta el dictado activo: deja de contar como «en curso». */
  private detach(s: Session): void {
    this.current = null;
    this.clearTimers();
    this.setMuted(false);
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
        if (file) this.feedback.concluded(s.id, 'cancelled');
      }
      return;
    }

    if (shown) {
      this.setStatus('processing', 'audio complete');
      this.feedback.sound('stop');
    }
    let result: DictationResult;
    if (pcm.length === 0) {
      result = { ...this.result(s, null), outcome: 'discarded', reason: 'no_audio', message: 'No audio was recorded.' };
    } else {
      const file = await this.save(s, pcm);
      result = file
        ? await this.transcribe(s, file, pcm, durationMs)
        : { ...this.result(s, null), outcome: 'failed', reason: 'write_failed', message: 'Could not save the audio.' };
      if (result.outcome === 'done') result = await this.format(s, result);
      if (result.outcome === 'done') result = await this.paste(s, result);
    }
    this.conclude(s, result);
  }

  /** Silencia la salida durante la grabación, o le devuelve el sonido. */
  private setMuted(on: boolean): void {
    if (this.muteTimer) clearTimeout(this.muteTimer);
    this.muteTimer = null;
    if (on === this.muted) return;
    this.muted = on;
    void this.helper
      .request('SetOutputMuted', { muted: on })
      .then((r) => log.info(`Output ${on ? 'mute' : 'unmute'}: ${r.payload.detail}`))
      .catch((err: Error) => log.warn(`SetOutputMuted failed: ${err.message}`));
  }

  /** Muestra el resultado y avisa de lo que haya salido mal. */
  private conclude(s: Session, result: DictationResult): void {
    this.feedback.concluded(s.id, result.outcome);
    if (this.state.id === s.id) {
      this.setStatus('idle', result.reason, { handsFree: false, level: 0, last: result });
    } else {
      this.patch({ last: result });
    }
    if (result.outcome === 'cancelled' && result.reason === 'user_action_escape') {
      this.feedback.notify(notice.cancelled(s.id));
    } else if (result.outcome === 'failed') {
      const n = result.reason.startsWith('transcription_')
        ? notice.transcriptionFailed(result.message, s.id)
        : notice.recordingFailed(result.message, s.id);
      this.feedback.notify(n);
    } else if (result.outcome === 'done' && result.reason === 'no_speech') {
      this.feedback.notify(notice.noSpeech(s.id));
    } else if (result.outcome === 'done' && result.format?.result.startsWith('raw_')) {
      // Si el pegado falla, su aviso sustituirá a este al llegar el resultado.
      this.feedback.notify(notice.formatFallback(result.format.result, this.store.get().formatting, s.id));
    }
  }

  private async transcribe(s: Session, file: string, pcm: Buffer, durationMs: number): Promise<DictationResult> {
    const language = this.store.get().prefs.dictationLanguage;
    if (s.recovered) this.updateHistory(s.id, { status: 'processing', language, error: null });
    else this.record(s, durationMs, file, 'processing', { language });
    const audioStart = s.startedAt + (s.openMs ?? 0);
    const voice = checkVoice(pcm, s.soundsAt.map((t) => t - audioStart), this.voiceLevels.get(s.device));
    const levels =
      `floor ${voice.floorDb.toFixed(0)} dBFS, peak ${voice.peakDb.toFixed(0)} dBFS, ` +
      `voice ${voice.voiceDb?.toFixed(0) ?? '-'} dBFS, minimum ${voice.gateDb.toFixed(0)} dBFS`;
    this.voiceLevels.learn(s.device, voice.voiceDb, voice.speechMs < MIN_SPEECH_MS);
    if (voice.speechMs < MIN_SPEECH_MS) {
      // Sin voz, whisper se inventaría una frase: ni se transcribe ni se pega.
      log.info(`Dictation ${short(s.id)}: no speech (${voice.speechMs} ms above the threshold, ${levels}); not transcribing`);
      this.updateHistory(s.id, { status: 'done', asrText: '' });
      return {
        ...this.result(s, file),
        durationMs,
        outcome: 'done',
        reason: 'no_speech',
        message: 'No speech detected.',
        text: '',
        rawText: '',
        language,
      };
    }
    log.info(`Dictation ${short(s.id)}: ${voice.speechMs} ms of speech (${levels})`);
    const abort = new AbortController();
    if (!s.background) this.transcribing = { id: s.id, abort };
    const base = { ...this.result(s, file), durationMs };
    try {
      const r = await this.engine.transcribe({
        id: s.id,
        audioPath: file,
        durationMs,
        language,
        vocabulary: this.words.terms(),
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
        rawText: r.text,
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
        message: cancelled ? 'Cancelled. The audio is kept in your history.' : `${e.message.replace(/[^.!?]$/, '$&.')} The audio is kept in your history.`,
      };
    } finally {
      if (this.transcribing?.abort === abort) this.transcribing = null;
    }
  }

  // MARK: Formateo

  /**
   * Formatea la transcripción y la ajusta al texto que rodea al cursor. Si el
   * formateo no está, tarda demasiado o devuelve otra cosa, se pega la
   * transcripción tal cual y el motivo queda en el historial.
   */
  private async format(s: Session, r: DictationResult): Promise<DictationResult> {
    const raw = r.text ?? '';
    if (!raw.trim()) return r;
    const target = await s.target;
    const vocabulary = this.words.terms();
    const abort = new AbortController();
    if (!s.background) this.transcribing = { id: s.id, abort };
    try {
      const o = await this.formatting.format(
        {
          id: s.id,
          text: raw,
          language: r.language ?? this.store.get().prefs.dictationLanguage,
          appName: target?.appName ?? null,
          surroundings: target?.surroundings ?? null,
          vocabulary,
        },
        abort.signal,
      );
      // Las sustituciones del diccionario van sobre el texto final, formateado o no.
      const sub = this.words.substitute(o.text);
      if (sub.count) log.info(`Dictation ${short(s.id)}: ${sub.count} dictionary ${sub.count === 1 ? 'replacement' : 'replacements'}`);
      const text = fitToSurroundings(sub.text, target?.surroundings ?? null, this.words.spellings());
      if (target && !target.surroundings) log.info(`Dictation ${short(s.id)}: no text around the cursor (${target.surroundingsUnavailable})`);
      let format: FormatInfo;
      if (o.result === 'formatted') {
        format = { result: o.result, model: o.formatted.model, ms: o.formatted.ms };
        this.updateHistory(s.id, {
          formattedText: sub.text,
          formatResult: o.result,
          formatProvider: o.formatted.provider,
          formatModel: o.formatted.model,
          formatMs: o.formatted.ms,
        });
      } else if (o.result === 'off') {
        format = { result: o.result, model: null, ms: null };
        this.updateHistory(s.id, { formatResult: o.result, ...(sub.count ? { formattedText: sub.text } : {}) });
      } else {
        format = { result: o.result, model: o.model, ms: o.ms };
        this.updateHistory(s.id, {
          // Sin formateo, el texto con las sustituciones es la versión editada de la fila.
          ...(sub.count ? { formattedText: sub.text } : {}),
          formatResult: o.result,
          formatProvider: o.provider,
          formatModel: o.model,
          formatMs: o.ms,
          formatError: o.error,
        });
      }
      return { ...r, text, format };
    } catch (err) {
      if (!(err instanceof FormatError && err.code === 'cancelled')) throw err;
      this.updateHistory(s.id, { status: 'cancelled', formatResult: 'raw_cancelled', error: 'user_action_escape: cancelled while formatting' });
      return { ...r, outcome: 'cancelled', reason: 'user_action_escape', message: 'Cancelled. The text is kept in your history.' };
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
      settled = this.pasted(s, sentAt, o, text);
    });
    await job.posted;
    return { ...r, paste: settled ?? { result: 'pending', appName: target?.appName ?? null, ms: null } };
  }

  /** Resultado del pegado: completa la fila y, si se ve, el último dictado. */
  private pasted(s: Session, sentAt: number, o: PasteOutcome, text: string): PasteInfo {
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
    // Sin campo de texto, el aviso enseña lo dictado y deja copiarlo.
    if (isPasteFailure(o.result)) {
      this.feedback.notify(text.trim() ? notice.pasteFailedWithText(text.trim(), s.id) : notice.pasteFailed(s.id));
    }
    return info;
  }

  /** El texto del último dictado (para enseñarlo en el menú del icono). */
  lastTranscript(): string | null {
    return this.lastText();
  }

  /** «Paste last transcript» del menú de la barra. */
  pasteLastFromMenu(): void {
    this.pasteLast();
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
    void job.outcome.then((o) => {
      log.info(`Paste last ${short(id)}: ${o.result} in ${o.appName ?? '?'}`);
      if (isPasteFailure(o.result)) this.feedback.notify(notice.pasteFailed(null));
    });
  }

  /**
   * «Undo» del aviso de cancelación: vuelve a transcribir el audio guardado
   * del dictado cancelado, lo formatea y lo pega donde esté el foco ahora. La
   * fila del historial es la misma.
   */
  async recover(id: string): Promise<void> {
    if (this.state.status !== 'idle') {
      this.feedback.notify(notice.busy());
      return;
    }
    const { file, wav } = await this.readAudio(id);
    if (!file || !wav) {
      log.info(`Dictation ${short(id)}: nothing to recover`);
      this.feedback.notify(notice.nothingToRecover());
      return;
    }
    if (this.state.status !== 'idle') return;
    const pcm = wav.subarray(WAV_HEADER_BYTES);
    const durationMs = Math.round(pcm.length / BYTES_PER_MS);
    const now = Date.now();
    const s = savedSession(id, now, pcm.length, this.paster.captureTarget(id, this.store.get().prefs.contextAwareness), false, this.store.get().prefs.enableSounds);
    log.info(`Dictation ${short(id)}: recovering ${durationMs} ms of cancelled audio`);
    this.feedback.clearNotice();
    this.engine.prepare(this.store.get().prefs.dictationLanguage);
    this.formatting.prepare();
    this.setStatus('processing', 'undo cancel', { id, startedAt: now, handsFree: false, level: 0, micSilent: false });
    let result = await this.transcribe(s, file, pcm, durationMs);
    if (result.outcome === 'done') result = await this.format(s, result);
    if (result.outcome === 'done') result = await this.paste(s, result);
    this.conclude(s, result);
  }

  /**
   * «Retry transcript» del Hub: vuelve a transcribir y formatear el audio
   * guardado de un dictado y reescribe su fila. No pega nada ni se ve en la
   * barra. Sirve también para recuperar un dictado cancelado o fallido.
   */
  async retry(id: string): Promise<HistoryActionResult> {
    if (this.state.status !== 'idle') return { ok: false, message: 'Cannot retry while dictating.' };
    if (this.retrying.has(id)) return { ok: true };
    const { file, wav } = await this.readAudio(id);
    if (!file || !wav) {
      return { ok: false, message: 'Cannot retry the transcription: its audio is no longer available (older than 14 days).' };
    }
    const pcm = wav.subarray(WAV_HEADER_BYTES);
    const durationMs = Math.round(pcm.length / BYTES_PER_MS);
    const s = savedSession(id, Date.now(), pcm.length, Promise.resolve(null), true, this.store.get().prefs.enableSounds);
    log.info(`Dictation ${short(id)}: retrying ${durationMs} ms of audio from the history`);
    this.retrying.add(id);
    try {
      this.formatting.prepare();
      // El texto anterior deja de valer: la fila se rehace entera.
      this.updateHistory(id, {
        formattedText: null,
        formatResult: null,
        formatProvider: null,
        formatModel: null,
        formatMs: null,
        formatError: null,
        showFormatted: true,
      });
      let result = await this.transcribe(s, file, pcm, durationMs);
      if (result.outcome === 'done') result = await this.format(s, result);
      log.info(`Dictation ${short(id)}: retry ${result.outcome} (${result.reason})`);
      return result.outcome === 'done' ? { ok: true } : { ok: false, message: 'Retry failed. Please try again.' };
    } catch (err) {
      log.error(`Dictation ${short(id)}: retry failed`, err);
      this.updateHistory(id, { status: 'failed', error: `retry_failed: ${(err as Error).message}` });
      return { ok: false, message: 'Retry failed. Please try again.' };
    } finally {
      this.retrying.delete(id);
    }
  }

  /** El WAV guardado de un dictado, si sigue ahí y tiene audio. */
  private async readAudio(id: string): Promise<{ file: string | null; wav: Buffer | null }> {
    const file = this.history?.audioPath(id) ?? null;
    if (!file) return { file: null, wav: null };
    try {
      const wav = await readFile(file);
      return wav.length > WAV_HEADER_BYTES ? { file, wav } : { file, wav: null };
    } catch (err) {
      log.warn(`Could not read ${file}: ${(err as Error).message}`);
      return { file, wav: null };
    }
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
    // Sin los espacios añadidos para el campo donde se pegó: ahora va a otro sitio.
    if (last?.outcome === 'done' && last.text?.trim()) return last.text.trim();
    try {
      return this.history?.lastText()?.trim() ?? null;
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

  private onRecorderEvent(e: RecordingEvent): void {
    if (e.type === 'ready') return;
    const s = this.current?.id === e.id ? this.current : this.closing.get(e.id);
    if (!s) return;
    switch (e.type) {
      case 'started':
        s.openMs = e.openMs;
        s.device = e.device;
        this.feedback.microphoneUsed(e.device);
        log.info(`Dictation ${short(s.id)}: microphone open in ${e.openMs} ms (${e.device}, ${e.sampleRate} Hz)`);
        if (this.current === s && this.state.status === 'initializing') this.setStatus('listening', 'microphone open');
        break;
      case 'failed':
        log.error(`Dictation ${short(s.id)}: recorder failed: ${e.error}`);
        if (this.current === s && this.state.status === 'listening' && s.bytes >= MIN_KEEP_BYTES) {
          // El micrófono se fue a mitad (auriculares desconectados, otro
          // dispositivo): lo grabado hasta ahí se transcribe y se pega.
          this.stop('microphone_lost');
          this.feedback.notify(notice.microphoneLost());
          break;
        }
        if (this.current === s) {
          this.cancel('recorder_failed', 'failure', `Could not record: ${e.error}`);
        }
        void this.finish(s);
        break;
      case 'silent':
        log.warn(`Dictation ${short(s.id)}: the microphone has sent only silence for 5 s`);
        if (this.current === s) {
          this.patch({ micSilent: true });
          this.feedback.notify(notice.micSilent(s.id));
        }
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

/**
 * Sesión para un dictado que ya está grabado y guardado en el historial. No se
 * guardó cuándo sonó la app, pero el sonido de empezar va siempre al
 * principio de la grabación: con los sonidos activados, no cuenta como voz (si
 * no, una grabación en silencio pasaría por voz y whisper se inventaría texto).
 */
function savedSession(
  id: string,
  now: number,
  bytes: number,
  target: Promise<PasteTargetInfo | null>,
  background: boolean,
  sounds: boolean,
): Session {
  return {
    id,
    startedAt: now,
    openMs: null,
    chunks: [],
    bytes,
    nextIndex: 0,
    lost: 0,
    pendingVolumes: [],
    outcome: null,
    reason: background ? 'retry' : 'undo_cancel',
    message: '',
    keepAudio: false,
    doneTimer: null,
    target,
    stoppedAt: now,
    audioAt: now,
    recovered: true,
    background,
    soundsAt: sounds ? [now] : [],
    device: null,
  };
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
    rawText: null,
    format: null,
    language: null,
    transcriptionMs: null,
    paste: null,
    at: Date.now(),
  };
}

function short(id: string): string {
  return id.slice(0, 8);
}
