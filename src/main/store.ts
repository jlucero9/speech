import type { WebContents } from 'electron';
import { IPC } from '../shared/ipc';
import { FORMATTING_MODELS } from '../shared/formatting';
import { DEFAULT_PREFERENCES } from '../shared/preferences';
import type { SharedState } from '../shared/state';
import { DEFAULT_LOCAL_MODEL, LOCAL_MODELS } from '../shared/transcription';

// Estado compartido entre main y las ventanas que lo piden. Varios cambios
// seguidos se envían juntos en un solo mensaje al final de la tarea en curso.
// Solo lo reciben las ventanas que se han suscrito (la de grabación no).

type Listener = (state: SharedState) => void;

export class Store {
  private state: SharedState;
  private listeners = new Set<Listener>();
  private broadcastPending = false;
  private targets = new Set<WebContents>();

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

  /** Envía cada cambio a esta ventana hasta que se destruya. */
  addTarget(contents: WebContents): void {
    if (this.targets.has(contents)) return;
    this.targets.add(contents);
    contents.once('destroyed', () => this.targets.delete(contents));
  }

  private scheduleBroadcast(): void {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    queueMicrotask(() => {
      this.broadcastPending = false;
      for (const contents of this.targets) {
        if (!contents.isDestroyed()) contents.send(IPC.stateChanged, this.state);
      }
    });
  }
}

export function initialState(): SharedState {
  return {
    helper: { status: 'starting', pid: null, restarts: 0, nextAttemptAt: null, lastError: null },
    permissions: { accessibility: 'unknown', microphone: 'unknown' },
    keyboard: { tap: 'unknown', tapReason: null, inputMonitoring: 'unknown', secureInput: null, fnUsage: 'unknown' },
    dictation: {
      status: 'idle',
      id: null,
      startedAt: null,
      handsFree: false,
      level: 0,
      micSilent: false,
      last: null,
    },
    transcription: {
      engine: 'local',
      model: {
        id: DEFAULT_LOCAL_MODEL,
        status: 'checking',
        receivedBytes: 0,
        totalBytes: LOCAL_MODELS[DEFAULT_LOCAL_MODEL].sizeBytes,
        bytesPerSecond: null,
        error: null,
        retryAt: null,
      },
      transcriber: { status: 'stopped', pid: null, memoryBytes: null, unloadAt: null, error: null },
    },
    formatting: {
      provider: DEFAULT_PREFERENCES.formattingProvider,
      model: FORMATTING_MODELS[DEFAULT_PREFERENCES.formattingProvider],
      status: 'checking',
      detail: null,
    },
    data: { databaseReady: false, schemaVersion: 0, migrationsAppliedThisLaunch: 0, error: null },
    prefs: { ...DEFAULT_PREFERENCES },
  };
}
