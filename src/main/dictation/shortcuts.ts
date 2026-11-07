import { EventEmitter } from 'node:events';
import type { HelperEvents } from '../../shared/helper-protocol';
import { comboMatches, keyMatches, type ShortcutAction, type ShortcutBinding } from '../../shared/shortcuts';
import type { ShortcutRecording } from '../../shared/state';
import type { HelperProcess } from '../helper/helper-process';
import { logger } from '../log';

// Interpreta las teclas que envía el helper y las convierte en acciones.
//
// - Lleva el conjunto de teclas pulsadas, con la hora de cada una. Una
//   pulsación de una tecla que ya consta como pulsada no dispara nada.
// - Un atajo se activa cuando el conjunto de teclas pulsadas es exactamente
//   el suyo (sin importar el orden) y no hay otras pulsadas que el helper no
//   envió. «Cancelar» se dispara aunque haya otras teclas pulsadas.
// - Con un atajo pulsado, otra tecla que complete otro atajo lo sustituye
//   (fn y después Espacio: de push-to-talk a manos libres); si no completa
//   ninguno, se avisa como combinación ajena.
// - La suelta de cualquier tecla del atajo activo lo suelta.
// - Teclas atascadas (se perdió la suelta): cada 5 s, y antes de aceptar un
//   atajo con una tecla pulsada desde hace más de 2,5 s, se pregunta al
//   helper cuáles siguen pulsadas de verdad.
// - Si el helper se reinicia o se pierde, todo se da por suelto.
// - ⌘, ⇧, ⌥ y ⌃ «de cualquier lado» en un atajo valen con cualquiera de las
//   dos teclas (shared/shortcuts.ts).
// - Grabación (editor de atajos): no se dispara ningún atajo; se junta lo que
//   se pulsa hasta soltarlo todo y eso es la combinación.

const log = logger('shortcuts');

const STALE_CHECK_EVERY_MS = 5_000;
const STALE_KEY_AGE_MS = 2_500;
const STALE_CHECK_TIMEOUT_MS = 500;
/** Lo mismo que espera el helper antes de apagar la grabación de un atajo. */
const RECORDING_TIMEOUT_MS = 60_000;
/**
 * Con `npm run start:debug` se registran las teclas recibidas del helper, pero
 * solo los modificadores y fn: el resto sale como «other key», sin código, para
 * que el registro no guarde lo que se escribe.
 */
const LOG_KEYS = process.env.SPEECH_DEBUG === '1';
/** ⌘ derecho (54) a fn (63): ⌘, ⇧, ⇪, ⌥ y ⌃ de los dos lados. */
const isModifierKey = (key: number): boolean => key >= 54 && key <= 63;

export interface ShortcutEvents {
  down: [ShortcutAction];
  up: [ShortcutAction];
  /** Otra tecla pulsada mientras se mantiene un atajo. */
  chord: [ShortcutAction];
  /** Mientras se graba un atajo, en cada tecla. */
  recording: [ShortcutRecording];
}

export class ShortcutListener extends EventEmitter<ShortcutEvents> {
  private pressed = new Map<number, number>();
  private hidden = 0;
  private lastIndex = 0;
  private active: ShortcutBinding | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;
  private recording: { held: Set<number>; combo: Set<number>; names: Record<string, string> } | null = null;
  private recordingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly helper: HelperProcess,
    private shortcuts: ShortcutBinding[],
  ) {
    super();
    helper.on('ready', () => {
      this.reset('helper ready');
      void this.sendShortcuts();
      if (this.recording) void this.sendRecording(true);
    });
    helper.on('state', (s) => {
      if (s.status !== 'ready') this.reset(`helper ${s.status}`);
    });
    helper.on('event', (e) => {
      if (e.type === 'KeyEvent') this.onKey(e.payload);
      if (e.type === 'TapStatus' && e.payload.state !== 'active') this.reset(`tap ${e.payload.state}`);
    });
  }

  /** Para comprobaciones: teclas que main da por pulsadas. */
  get pressedKeys(): number[] {
    return [...this.pressed.keys()];
  }

  get current(): ShortcutBinding[] {
    return this.shortcuts;
  }

  /** Atajos nuevos: se aplican en el acto, también en el helper. */
  setShortcuts(list: ShortcutBinding[]): void {
    this.shortcuts = list;
    this.reset('shortcuts changed');
    void this.sendShortcuts();
  }

  get isRecording(): boolean {
    return this.recording !== null;
  }

  /** Empieza a grabar un atajo: hasta pararla, las teclas no disparan nada. */
  startRecording(): void {
    if (!this.recording) log.info('Recording a shortcut');
    this.reset('recording a shortcut');
    this.recording = { held: new Set(), combo: new Set(), names: {} };
    void this.sendRecording(true);
    // El helper la apaga solo al minuto; aquí, a la vez, para no quedar sin atajos.
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    this.recordingTimer = setTimeout(() => this.stopRecording('timed out'), RECORDING_TIMEOUT_MS);
  }

  stopRecording(why: string): void {
    if (this.recordingTimer) clearTimeout(this.recordingTimer);
    this.recordingTimer = null;
    if (!this.recording) return;
    log.info(`Stopped recording a shortcut (${why})`);
    this.recording = null;
    this.reset('shortcut recording ended');
    void this.sendRecording(false);
  }

  private async sendRecording(on: boolean): Promise<void> {
    try {
      await this.helper.request('SetShortcutRecording', { on });
    } catch (err) {
      log.warn(`Could not ${on ? 'start' : 'stop'} shortcut recording in the helper: ${(err as Error).message}`);
    }
  }

  private onRecordingKey(key: number, down: boolean, name: string | undefined): void {
    const r = this.recording!;
    if (name) r.names[String(key)] = name;
    if (down) {
      // Una tecla nueva tras soltarlo todo empieza otra combinación.
      if (r.held.size === 0) r.combo.clear();
      r.held.add(key);
      r.combo.add(key);
    } else {
      r.held.delete(key);
    }
    const done = r.held.size === 0 && r.combo.size > 0 ? [...r.combo] : null;
    this.emit('recording', { held: [...r.held], done, names: { ...r.names } });
  }

  private async sendShortcuts(): Promise<void> {
    try {
      await this.helper.request('UpdateShortcuts', { shortcuts: this.shortcuts });
    } catch (err) {
      log.warn(`Could not send shortcuts to the helper: ${(err as Error).message}`);
    }
  }

  private onKey({ index, key, down, hidden, name }: HelperEvents['KeyEvent']): void {
    if (index === 1 && this.lastIndex > 0) {
      this.reset('helper restarted');
    } else if (this.lastIndex > 0 && index !== this.lastIndex + 1) {
      log.warn(`Key event index jumped from ${this.lastIndex} to ${index}`);
    }
    this.lastIndex = index;
    this.hidden = hidden;
    if (LOG_KEYS) {
      const what = isModifierKey(key) ? `Key ${key}` : 'Other key';
      log.info(`${what} ${down ? 'down' : 'up'} (#${index}, ${hidden} other held)`);
    }
    if (this.recording) {
      this.onRecordingKey(key, down, name);
      return;
    }

    if (down) {
      if (this.pressed.has(key)) {
        // Autorrepetición o pulsación duplicada.
        this.pressed.set(key, Date.now());
        return;
      }
      this.pressed.set(key, Date.now());
      void this.evaluateDown(key);
    } else {
      this.release(key);
    }
    this.scheduleStaleCheck();
  }

  private release(key: number): void {
    if (!this.pressed.delete(key)) return;
    if (this.active?.keys.some((k) => keyMatches(k, key))) {
      const action = this.active.action;
      this.active = null;
      this.emit('up', action);
    }
  }

  private async evaluateDown(key: number): Promise<void> {
    const pressed = [...this.pressed.keys()];
    const dismiss = this.shortcuts.find(
      (s) =>
        s.action === 'dismiss' &&
        s.keys.some((k) => keyMatches(k, key)) &&
        s.keys.every((k) => pressed.some((p) => keyMatches(k, p))),
    );
    if (dismiss) {
      this.emit('down', 'dismiss');
      return;
    }
    if (this.active) {
      // Otra tecla con un atajo pulsado: si juntas forman otro atajo (fn y
      // luego Espacio), pasa a ser ese; si no, es una combinación ajena.
      const next = this.match();
      if (next && next.action !== this.active.action) {
        this.active = next;
        this.emit('down', next.action);
      } else {
        this.emit('chord', this.active.action);
      }
      return;
    }

    let match = this.match();
    if (!match) return;

    // Una tecla del atajo lleva mucho rato «pulsada»: puede ser un resto.
    const now = Date.now();
    if ([...this.pressed].some(([k, at]) => k !== key && now - at > STALE_KEY_AGE_MS)) {
      await this.checkStale();
      if (!this.pressed.has(key)) return;
      match = this.match();
      if (!match || this.active) return;
    }
    this.active = match;
    this.emit('down', match.action);
  }

  private match(): ShortcutBinding | null {
    if (this.hidden > 0) return null;
    return (
      this.shortcuts.find((s) => s.action !== 'dismiss' && comboMatches(s.keys, this.pressed.keys())) ?? null
    );
  }

  private scheduleStaleCheck(): void {
    if (this.pressed.size === 0) {
      if (this.staleTimer) clearInterval(this.staleTimer);
      this.staleTimer = null;
      return;
    }
    if (this.staleTimer) return;
    this.staleTimer = setInterval(() => void this.checkStale(), STALE_CHECK_EVERY_MS);
  }

  private checkStale(): Promise<void> {
    if (this.checking) return this.checking;
    const keys = [...this.pressed.keys()];
    if (keys.length === 0) return Promise.resolve();
    this.checking = this.helper
      .request('CheckStaleKeys', { keys }, STALE_CHECK_TIMEOUT_MS)
      .then((res) => {
        for (const key of res.payload.released) {
          if (!this.pressed.has(key)) continue;
          log.warn(`Key ${key} was stuck (release lost); releasing it`);
          this.release(key);
        }
      })
      .catch((err: Error) => log.warn(`Stale key check failed: ${err.message}`))
      .finally(() => {
        this.checking = null;
        this.scheduleStaleCheck();
      });
    return this.checking;
  }

  /** Da todo por suelto; si había un atajo activo, emite su suelta. */
  private reset(why: string): void {
    const active = this.active;
    if (this.pressed.size) log.info(`Clearing ${this.pressed.size} pressed key(s): ${why}`);
    this.pressed.clear();
    this.hidden = 0;
    this.lastIndex = 0;
    this.active = null;
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    if (active) this.emit('up', active.action);
  }
}
