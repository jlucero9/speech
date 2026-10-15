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
  requestInputMonitoring: () => ipcRenderer.invoke(IPC.requestInputMonitoring),
  openInputMonitoringSettings: () => ipcRenderer.invoke(IPC.openInputMonitoringSettings),
  openKeyboardSettings: () => ipcRenderer.invoke(IPC.openKeyboardSettings),
  revealRecording: () => ipcRenderer.invoke(IPC.revealRecording),
};

contextBridge.exposeInMainWorld('speech', api);
