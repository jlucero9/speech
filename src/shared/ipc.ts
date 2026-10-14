// Canales IPC entre ventanas y main. El preload solo expone estos; no hay un
// puente genérico que acepte cualquier nombre de canal.

import type { Preferences } from './preferences';
import type { SharedState } from './state';

export const IPC = {
  getState: 'state:get',
  stateChanged: 'state:changed',
  setPreference: 'prefs:set',
  requestAccessibility: 'permissions:request-accessibility',
  requestMicrophone: 'permissions:request-microphone',
  openAccessibilitySettings: 'permissions:open-accessibility-settings',
  retryHelper: 'helper:retry',
} as const;

/** API que el preload publica como window.speech. */
export interface SpeechApi {
  getState(): Promise<SharedState>;
  /** Devuelve la función para darse de baja. */
  onState(listener: (state: SharedState) => void): () => void;
  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void>;
  requestAccessibility(): Promise<void>;
  requestMicrophone(): Promise<void>;
  openAccessibilitySettings(): Promise<void>;
  retryHelper(): Promise<void>;
}
