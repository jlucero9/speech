import { BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import type { SharedState } from '../shared/state';

// Estado compartido entre main y todas las ventanas. Varios cambios seguidos
// se envían juntos en un solo mensaje al final de la tarea en curso.

type Listener = (state: SharedState) => void;

export class Store {
  private state: SharedState;
  private listeners = new Set<Listener>();
  private broadcastPending = false;

  constructor(initial: SharedState) {
    this.state = initial;
  }

  get(): SharedState {
    return this.state;
  }

  update(recipe: (state: SharedState) => SharedState): void {
    const next = recipe(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l(next);
    this.scheduleBroadcast();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleBroadcast(): void {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    queueMicrotask(() => {
      this.broadcastPending = false;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.stateChanged, this.state);
      }
    });
  }
}

export function initialState(): SharedState {
  return {
    helper: { status: 'starting', pid: null, restarts: 0, nextAttemptAt: null, lastError: null },
    permissions: { accessibility: 'unknown', microphone: 'unknown' },
    data: { databaseReady: false, schemaVersion: 0, migrationsAppliedThisLaunch: 0, error: null },
    prefs: { ...DEFAULT_PREFERENCES },
  };
}
