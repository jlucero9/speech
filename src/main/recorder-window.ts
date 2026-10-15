import { BrowserWindow, ipcMain, session, type IpcMainEvent, type WebContents } from 'electron';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { RECORDER_IPC, type RecorderCommand, type RecorderEvent } from '../shared/ipc';
import { logger } from './log';

// Ventana oculta que captura el micrófono. Vive mientras vive la app, así que
// el Hub puede estar cerrado: no carga React ni pinta nada. El micrófono solo
// se abre durante un dictado.
//
// Si su proceso muere, se avisa del dictado en curso y se vuelve a crear.

const log = logger('recorder');

const RECREATE_DELAY_MS = 1_000;

export interface RecorderEvents {
  event: [RecorderEvent];
  chunk: [id: string, index: number, pcm: Buffer, volume: number];
}

export class RecorderWindow extends EventEmitter<RecorderEvents> {
  private win: BrowserWindow | null = null;
  private ready = false;
  private queue: RecorderCommand[] = [];
  /** Dictado que la ventana tiene abierto, para avisar si muere. */
  private openId: string | null = null;
  private stopped = false;

  constructor() {
    super();
    ipcMain.on(RECORDER_IPC.event, (e, event: RecorderEvent) => {
      if (!this.fromRecorder(e)) return;
      this.onEvent(event);
    });
    ipcMain.on(RECORDER_IPC.chunk, (e, id: string, index: number, pcm: ArrayBuffer, volume: number) => {
      if (!this.fromRecorder(e)) return;
      this.emit('chunk', id, index, Buffer.from(pcm), volume);
    });
  }

  get contents(): WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  get pid(): number | null {
    return this.contents?.getOSProcessId() ?? null;
  }

  create(): void {
    if (this.win && !this.win.isDestroyed()) return;
    this.ready = false;
    const win = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      focusable: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: false,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'recorder.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        webgl: false,
        enableWebSQL: false,
        // Oculta, una ventana se ralentiza; la captura no debe.
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.win = win;
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`Recorder process gone (${details.reason}, code ${details.exitCode})`);
      this.lost(`recorder process ${details.reason}`);
      if (!win.isDestroyed()) win.destroy();
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.ready = false;
        if (!this.stopped) {
          this.lost('recorder window closed');
          setTimeout(() => this.create(), RECREATE_DELAY_MS);
        }
      }
    });
    void win.loadFile(join(__dirname, '..', 'renderer', 'recorder', 'index.html'));
  }

  /** Solo la ventana de grabación puede pedir el micrófono. */
  installPermissionHandlers(): void {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const audioOnly =
        permission === 'media' &&
        'mediaTypes' in details &&
        (details.mediaTypes ?? []).length > 0 &&
        (details.mediaTypes ?? []).every((t) => t === 'audio');
      const allowed = contents === this.contents && audioOnly;
      if (!allowed) log.warn(`Denied permission ${permission}`);
      callback(allowed);
    });
    ses.setPermissionCheckHandler((contents, permission) => permission === 'media' && contents === this.contents);
  }

  start(id: string): void {
    this.send({ type: 'start', id });
  }

  stop(id: string): void {
    this.send({ type: 'stop', id });
  }

  shutdown(): void {
    this.stopped = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private send(command: RecorderCommand): void {
    if (!this.ready || !this.contents) {
      this.queue.push(command);
      this.create();
      return;
    }
    this.contents.send(RECORDER_IPC.command, command);
  }

  private onEvent(event: RecorderEvent): void {
    switch (event.type) {
      case 'ready':
        this.ready = true;
        log.info(`Recorder ready (pid ${this.pid})`);
        for (const c of this.queue.splice(0)) this.contents?.send(RECORDER_IPC.command, c);
        return;
      case 'started':
        this.openId = event.id;
        break;
      case 'failed':
      case 'done':
        if (this.openId === event.id) this.openId = null;
        break;
    }
    this.emit('event', event);
  }

  private lost(error: string): void {
    const id = this.openId;
    this.openId = null;
    this.ready = false;
    if (id) this.emit('event', { type: 'failed', id, error });
  }

  private fromRecorder(e: IpcMainEvent): boolean {
    return e.sender === this.contents;
  }
}
