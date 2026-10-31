import { contextBridge, ipcRenderer } from 'electron';
import { HUB_EVENTS, IPC, isHubPage, type SpeechApi } from '../shared/ipc';
import type { SharedState, ShortcutRecording } from '../shared/state';

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
  revealRecording: (id) => ipcRenderer.invoke(IPC.revealRecording, id),
  downloadModel: () => ipcRenderer.invoke(IPC.downloadModel),
  openMicrophoneSettings: () => ipcRenderer.invoke(IPC.openMicrophoneSettings),
  onNavigate: (listener) => {
    const handler = (_e: unknown, page: unknown) => {
      if (isHubPage(page)) listener(page);
    };
    ipcRenderer.on(HUB_EVENTS.navigate, handler);
    return () => ipcRenderer.removeListener(HUB_EVENTS.navigate, handler);
  },
  onHistoryChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(HUB_EVENTS.historyChanged, handler);
    return () => ipcRenderer.removeListener(HUB_EVENTS.historyChanged, handler);
  },
  listHistory: (q) => ipcRenderer.invoke(IPC.listHistory, q),
  historyStats: () => ipcRenderer.invoke(IPC.historyStats),
  historyAudio: (id) => ipcRenderer.invoke(IPC.historyAudio, id),
  copyTranscript: (id) => ipcRenderer.invoke(IPC.copyTranscript, id),
  setShowFormatted: (id, show) => ipcRenderer.invoke(IPC.setShowFormatted, id, show),
  setFlagged: (id, flagged) => ipcRenderer.invoke(IPC.setFlagged, id, flagged),
  retryTranscript: (id) => ipcRenderer.invoke(IPC.retryTranscript, id),
  deleteTranscript: (id) => ipcRenderer.invoke(IPC.deleteTranscript, id),
  extractAudio: (id) => ipcRenderer.invoke(IPC.extractAudio, id),
  onDictionaryChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on(HUB_EVENTS.dictionaryChanged, handler);
    return () => ipcRenderer.removeListener(HUB_EVENTS.dictionaryChanged, handler);
  },
  listDictionary: () => ipcRenderer.invoke(IPC.listDictionary),
  addWord: (input) => ipcRenderer.invoke(IPC.addWord, input),
  editWord: (id, input) => ipcRenderer.invoke(IPC.editWord, id, input),
  removeWords: (ids) => ipcRenderer.invoke(IPC.removeWords, ids),
  starWord: (id, starred) => ipcRenderer.invoke(IPC.starWord, id, starred),
  restoreWords: (entries) => ipcRenderer.invoke(IPC.restoreWords, entries),
  chooseDictionaryFile: () => ipcRenderer.invoke(IPC.chooseDictionaryFile),
  importDictionary: (items) => ipcRenderer.invoke(IPC.importDictionary, items),
  recordShortcut: (on) => ipcRenderer.invoke(IPC.recordShortcut, on),
  onShortcutRecording: (listener) => {
    const handler = (_e: unknown, r: ShortcutRecording) => listener(r);
    ipcRenderer.on(HUB_EVENTS.shortcutRecording, handler);
    return () => ipcRenderer.removeListener(HUB_EVENTS.shortcutRecording, handler);
  },
  monitorMicrophone: (device) => ipcRenderer.invoke(IPC.monitorMicrophone, device),
  onMicrophoneLevel: (listener) => {
    const handler = (_e: unknown, level: number) => listener(level);
    ipcRenderer.on(HUB_EVENTS.microphoneLevel, handler);
    return () => ipcRenderer.removeListener(HUB_EVENTS.microphoneLevel, handler);
  },
  resetSettings: () => ipcRenderer.invoke(IPC.resetSettings),
};

contextBridge.exposeInMainWorld('speech', api);
