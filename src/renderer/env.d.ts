import type { SpeechApi } from '../shared/ipc';

declare global {
  interface Window {
    speech: SpeechApi;
  }
}
