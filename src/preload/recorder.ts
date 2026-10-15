import { contextBridge, ipcRenderer } from 'electron';
import { RECORDER_IPC, type RecorderApi, type RecorderCommand } from '../shared/ipc';

// Preload de la ventana de grabación: solo sus tres canales.

const api: RecorderApi = {
  onCommand: (listener) => {
    ipcRenderer.on(RECORDER_IPC.command, (_e, command: RecorderCommand) => listener(command));
  },
  send: (event) => ipcRenderer.send(RECORDER_IPC.event, event),
  chunk: (id, index, pcm, volume) => ipcRenderer.send(RECORDER_IPC.chunk, id, index, pcm, volume),
};

contextBridge.exposeInMainWorld('recorder', api);
