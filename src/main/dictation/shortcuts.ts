import { EventEmitter } from 'node:events';
import type { HelperEvents } from '../../shared/helper-protocol';
import type { ShortcutAction, ShortcutBinding } from '../../shared/shortcuts';
import type { HelperProcess } from '../helper/helper-process';
import { logger } from '../log';

// Interpreta las teclas que envía el helper y las convierte en acciones.
//
// - Lleva el conjunto de teclas pulsadas, con la hora de cada una. Una
//   pulsación de una tecla que ya consta como pulsada no dispara nada.
// - Un atajo se activa cuando el conjunto de teclas pulsadas es exactamente
//   el suyo (sin importar el orden) y no hay otras pulsadas que el helper no
//   envió. «Cancelar» se dispara aunque haya otras teclas pulsadas.
// - La suelta de cualquier tecla del atajo activo lo suelta.
// - Teclas atascadas (se perdió la suelta): cada 5 s, y antes de aceptar un
//   atajo con una tecla pulsada desde hace más de 2,5 s, se pregunta al
//   helper cuáles siguen pulsadas de verdad.
// - Si el helper se reinicia o se pierde, todo se da por suelto.

const log = logger('shortcuts');

const STALE_CHECK_EVERY_MS = 5_000;
const STALE_KEY_AGE_MS = 2_500;
const STALE_CHECK_TIMEOUT_MS = 500;
/** Con `npm run start:debug` se registra cada tecla recibida del helper. */
const LOG_KEYS = process.env.SPEECH_DEBUG === '1';

export interface ShortcutEvents {
  down: [ShortcutAction];
  up: [ShortcutAction];
  /** Otra tecla pulsada mientras se mantiene un atajo. */
  chord: [ShortcutAction];
}

export class ShortcutListener extends EventEmitter<ShortcutEvents> {
  private pressed = new Map<number, number>();
  private hidden = 0;
  private lastIndex = 0;
  private active: ShortcutBinding | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;

  constructor(
    private readonly helper: HelperProcess,
    private shortcuts: ShortcutBinding[],
  ) {
    super();
    helper.on('ready', () => {
      this.reset('helper ready');
      void this.sendShortcuts();
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

  private async sendShortcuts(): Promise<void> {
    try {
      await this.helper.request('UpdateShortcuts', { shortcuts: this.shortcuts });
    } catch (err) {
      log.warn(`Could not send shortcuts to the helper: ${(err as Error).message}`);
    }
  }

  private onKey({ index, key, down, hidden }: HelperEvents['KeyEvent']): void {
    if (index === 1 && this.lastIndex > 0) {
      this.reset('helper restarted');
    } else if (this.lastIndex > 0 && index !== this.lastIndex + 1) {
      log.warn(`Key event index jumped from ${this.lastIndex} to ${index}`);
    }
    this.lastIndex = index;
    this.hidden = hidden;
    if (LOG_KEYS) log.info(`Key ${key} ${down ? 'down' : 'up'} (#${index}, ${hidden} other held)`);

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
    if (this.active?.keys.includes(key)) {
      const action = this.active.action;
      this.active = null;
      this.emit('up', action);
    }
  }

  private async evaluateDown(key: number): Promise<void> {
    const dismiss = this.shortcuts.find((s) => s.action === 'dismiss');
    if (dismiss?.keys.includes(key) && dismiss.keys.every((k) => this.pressed.has(k))) {
      this.emit('down', 'dismiss');
      return;
    }
    if (this.active) {
      this.emit('chord', this.active.action);
      return;
    }

    let match = this.match();
    if (!match) return;

    // Una tecla del atajo lleva mucho rato «pulsada»: puede ser un resto.
    const now = Date.now();
    if (match.keys.some((k) => k !== key && now - (this.pressed.get(k) ?? now) > STALE_KEY_AGE_MS)) {
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
      this.shortcuts.find(
        (s) => s.action !== 'dismiss' && s.keys.length === this.pressed.size && s.keys.every((k) => this.pressed.has(k)),
      ) ?? null
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
