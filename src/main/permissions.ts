import { shell, systemPreferences } from 'electron';
import type { MicrophonePermission } from '../shared/state';
import type { HelperProcess } from './helper/helper-process';
import { logger } from './log';
import type { Store } from './store';

// Accesibilidad: la consulta y la pide el helper, que es quien la necesita
// (el permiso queda ligado a su firma). Micrófono: lo consulta y lo pide main.

const log = logger('permissions');

const ACCESSIBILITY_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

export class Permissions {
  constructor(
    private readonly store: Store,
    private readonly helper: HelperProcess,
  ) {
    helper.on('ready', () => void this.refreshAccessibility());
    helper.on('state', (s) => {
      if (s.status !== 'ready') this.setAccessibility(null);
    });
    helper.on('event', (e) => {
      if (e.type === 'AccessibilityStatusChanged') {
        log.info(`Accessibility changed: ${e.payload.trusted ? 'granted' : 'denied'}`);
        this.setAccessibility(e.payload.trusted);
      }
    });
  }

  refreshMicrophone(): MicrophonePermission {
    const status = systemPreferences.getMediaAccessStatus('microphone') as MicrophonePermission;
    if (this.store.get().permissions.microphone !== status) {
      log.info(`Microphone: ${status}`);
      this.store.update((s) => ({ ...s, permissions: { ...s.permissions, microphone: status } }));
    }
    return status;
  }

  async requestMicrophone(): Promise<void> {
    log.info('Requesting microphone access');
    await systemPreferences.askForMediaAccess('microphone');
    this.refreshMicrophone();
  }

  async refreshAccessibility(): Promise<void> {
    try {
      const res = await this.helper.request('GetAccessibilityStatus');
      this.setAccessibility(res.payload.trusted);
    } catch (err) {
      log.warn(`Could not read accessibility status: ${(err as Error).message}`);
      this.setAccessibility(null);
    }
  }

  async requestAccessibility(): Promise<void> {
    log.info('Requesting accessibility access');
    const res = await this.helper.request('RequestAccessibilityPermission');
    this.setAccessibility(res.payload.trusted);
  }

  async openAccessibilitySettings(): Promise<void> {
    await shell.openExternal(ACCESSIBILITY_SETTINGS_URL);
  }

  private setAccessibility(trusted: boolean | null): void {
    const value = trusted === null ? 'unknown' : trusted ? 'granted' : 'denied';
    if (this.store.get().permissions.accessibility === value) return;
    this.store.update((s) => ({ ...s, permissions: { ...s.permissions, accessibility: value } }));
  }
}
