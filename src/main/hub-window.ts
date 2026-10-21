import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { HUB_EVENTS, type HubPage } from '../shared/ipc';

// La ventana principal. Se crea al abrirla y se destruye al cerrarla: con el
// Hub cerrado no queda ningún renderer vivo.

const WIDTH = 1350;
const HEIGHT = 850;
const MIN_WIDTH = 1140;
const MIN_HEIGHT = 750;

let hub: BrowserWindow | null = null;

export function openHub(page: HubPage, onFocus: () => void): BrowserWindow {
  if (hub && !hub.isDestroyed()) {
    if (hub.isMinimized()) hub.restore();
    hub.show();
    app.focus({ steal: true });
    hub.webContents.send(HUB_EVENTS.navigate, page);
    return hub;
  }

  // En una pantalla pequeña, la ventana cabe entera en el área útil.
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize;
  const width = Math.min(WIDTH, area.width);
  const height = Math.min(HEIGHT, area.height);

  hub = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(MIN_WIDTH, width),
    minHeight: Math.min(MIN_HEIGHT, height),
    show: false,
    title: 'Speech',
    backgroundColor: '#f5f4f0',
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 16, y: 19 },
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webgl: false,
      enableWebSQL: false,
    },
  });

  const win = hub;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    win.show();
    app.focus({ steal: true });
  });
  win.on('focus', onFocus);
  win.on('closed', () => {
    if (hub === win) hub = null;
  });

  // La página inicial va en el hash; las siguientes, por HUB_EVENTS.navigate.
  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'), { hash: page });
  return win;
}

/** Envía un evento al Hub si está abierto. */
export function sendToHub(channel: string, ...args: unknown[]): void {
  if (hub && !hub.isDestroyed()) hub.webContents.send(channel, ...args);
}

export function hubWindow(): BrowserWindow | null {
  return hub && !hub.isDestroyed() ? hub : null;
}
