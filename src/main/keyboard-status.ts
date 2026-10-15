import { app, Notification, shell } from 'electron';
import type { KeyboardStatusPayload, SecureInputPayload } from '../shared/helper-protocol';
import { blockedBySecureInput, type ShortcutBinding } from '../shared/shortcuts';
import type { KeyboardState, SecureInputOwner } from '../shared/state';
import type { HelperProcess } from './helper/helper-process';
import { logger } from './log';
import type { Store } from './store';

// Estado del atajo visto desde main: si el tap del helper funciona, si hace
// falta Monitorización de entrada, qué app tiene la entrada segura y qué hace
// macOS con la tecla 🌐.
//
// Entrada segura: mientras otra app la tiene activa (un campo de contraseña,
// un terminal con «Secure Keyboard Entry»), al helper no le llegan las teclas
// normales, aunque sí los modificadores. Solo se avisa si algún atajo depende
// de una tecla normal: en la ventana, en el icono de la barra de menús y con
// una notificación del sistema si dura más de un momento.

const log = logger('keyboard');

const INPUT_MONITORING_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent';
const KEYBOARD_SETTINGS_URL = 'x-apple.systempreferences:com.apple.Keyboard-Settings.extension';
/** Una contraseña tecleada en un par de segundos no merece notificación. */
const SECURE_INPUT_NOTIFY_AFTER_MS = 2_000;

export class KeyboardStatus {
  private notifyTimer: NodeJS.Timeout | null = null;
  private notification: Notification | null = null;

  constructor(
    private readonly store: Store,
    private readonly helper: HelperProcess,
    private readonly ownPids: () => number[],
    private readonly shortcuts: () => ShortcutBinding[],
    private readonly onSecureInputChange: (owner: SecureInputOwner | null) => void,
  ) {
    helper.on('ready', () => void this.refresh());
    helper.on('state', (s) => {
      if (s.status !== 'ready') this.patch({ tap: 'unknown', tapReason: `helper ${s.status}` });
    });
    helper.on('event', (e) => {
      switch (e.type) {
        case 'TapStatus':
          log.info(`Event tap: ${e.payload.state} (${e.payload.reason})`);
          if (e.payload.reason === 'storm') log.error('Event tap storm: the helper will exit and be restarted');
          this.patch({
            tap: e.payload.state === 'stopped' ? 'unknown' : e.payload.state,
            tapReason: e.payload.reason,
            inputMonitoring: e.payload.listenAccess ? 'granted' : 'denied',
          });
          break;
        case 'SecureInputStatus':
          this.setSecureInput(e.payload);
          break;
      }
    });
  }

  /** Relee todo del helper (al arrancar y al enfocar la ventana). */
  async refresh(): Promise<void> {
    if (this.helper.current.status !== 'ready') return;
    try {
      const res = await this.helper.request('GetKeyboardStatus');
      this.apply(res.payload);
    } catch (err) {
      log.warn(`Could not read keyboard status: ${(err as Error).message}`);
    }
  }

  async requestInputMonitoring(): Promise<void> {
    log.info('Requesting input monitoring access');
    const res = await this.helper.request('RequestInputMonitoring');
    this.patch({ inputMonitoring: res.payload.granted ? 'granted' : 'denied' });
  }

  async openInputMonitoringSettings(): Promise<void> {
    await shell.openExternal(INPUT_MONITORING_SETTINGS_URL);
  }

  async openKeyboardSettings(): Promise<void> {
    await shell.openExternal(KEYBOARD_SETTINGS_URL);
  }

  private apply(p: KeyboardStatusPayload): void {
    if (p.fnUsage !== this.store.get().keyboard.fnUsage) log.info(`Globe key setting: ${p.fnUsage}`);
    this.patch({
      tap: p.tap === 'stopped' ? 'unknown' : p.tap,
      tapReason: p.reason,
      inputMonitoring: p.listenAccess ? 'granted' : 'denied',
      fnUsage: p.fnUsage,
    });
    this.setSecureInput(p.secureInput);
  }

  private setSecureInput(p: SecureInputPayload): void {
    let owner: SecureInputOwner | null = null;
    // La propia app no cuenta: sus campos de contraseña no son un problema del atajo.
    if (p.blocked && !(p.pid && this.ownPids().includes(p.pid)) && blockedBySecureInput(this.shortcuts())) {
      owner = { pid: p.pid ?? 0, appName: p.appName ?? null, bundleId: p.bundleId ?? null, since: p.since ?? Date.now() };
    }
    const prev = this.store.get().keyboard.secureInput;
    if (prev?.pid === owner?.pid && prev?.appName === owner?.appName) return;
    log.info(owner ? `Secure input blocks the shortcut: ${owner.appName ?? 'unknown app'} (pid ${owner.pid})` : 'Secure input released');
    this.patch({ secureInput: owner });
    this.onSecureInputChange(owner);
    this.scheduleNotification(owner);
  }

  private scheduleNotification(owner: SecureInputOwner | null): void {
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    if (!owner) {
      this.notification?.close();
      this.notification = null;
      return;
    }
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      if (this.store.get().keyboard.secureInput?.pid !== owner.pid || !Notification.isSupported()) return;
      this.notification?.close();
      this.notification = new Notification({
        title: 'Your shortcut is blocked',
        body: `${owner.appName ?? 'Another app'} has secure input on, usually for a password field. Speech can't hear the fn key until you leave it.`,
        silent: true,
      });
      this.notification.show();
      log.info('Secure input notification shown');
    }, SECURE_INPUT_NOTIFY_AFTER_MS);
  }

  private patch(p: Partial<KeyboardState>): void {
    this.store.update((s) => ({ ...s, keyboard: { ...s.keyboard, ...p } }));
  }
}

/** PIDs de todos los procesos de esta app (main, ventanas, GPU…). */
export function appPids(): number[] {
  return app.getAppMetrics().map((m) => m.pid);
}
