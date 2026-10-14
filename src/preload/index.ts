import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type SpeechApi } from '../shared/ipc';
import type { SharedState } from '../shared/state';

const api: SpeechApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (listener) => {
    const handler = (_e: unknown, state: SharedState) => listener(state);
    ipcRenderer.on(IPC.stateChanged, handler);
    return () => ipcRenderer.removeListener(IPC.stateChanged, handler);
  },
  setPreference: (key, value) => ipcRenderer.invoke(IPC.setPreference, key, value),
  requestAccessibility: () => ipcRenderer.invoke(IPC.requestAccessibility),
  requestMicrophone: () => ipcRenderer.invoke(IPC.requestMicrophone),
  openAccessibilitySettings: () => ipcRenderer.invoke(IPC.openAccessibilitySettings),
  retryHelper: () => ipcRenderer.invoke(IPC.retryHelper),
};

contextBridge.exposeInMainWorld('speech', api);
