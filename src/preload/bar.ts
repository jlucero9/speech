import { contextBridge, ipcRenderer } from 'electron';
import type { BarSound } from '../shared/bar';
import { BAR_IPC, IPC, type BarApi } from '../shared/ipc';
import type { SharedState } from '../shared/state';

// Preload de la barra flotante: el estado y sus propios canales, nada más.

const api: BarApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  onState: (listener) => {
    const handler = (_e: unknown, state: SharedState) => listener(state);
    ipcRenderer.on(IPC.stateChanged, handler);
    return () => ipcRenderer.removeListener(IPC.stateChanged, handler);
  },
  setInteractive: (on) => ipcRenderer.send(BAR_IPC.interactive, on),
  command: (c) => ipcRenderer.send(BAR_IPC.command, c),
  drag: (d) => ipcRenderer.send(BAR_IPC.drag, d),
  onSound: (listener) => {
    const handler = (_e: unknown, sound: BarSound) => listener(sound);
    ipcRenderer.on(BAR_IPC.sound, handler);
    return () => ipcRenderer.removeListener(BAR_IPC.sound, handler);
  },
  onMenu: (listener) => {
    const handler = (_e: unknown, open: boolean) => listener(open === true);
    ipcRenderer.on(BAR_IPC.menu, handler);
    return () => ipcRenderer.removeListener(BAR_IPC.menu, handler);
  },
};

contextBridge.exposeInMainWorld('bar', api);
