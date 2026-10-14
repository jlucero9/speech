import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

// La ventana principal. Se crea al abrirla y se destruye al cerrarla: con el
// Hub cerrado no queda ningún renderer vivo.

let hub: BrowserWindow | null = null;

export function openHub(onFocus: () => void): BrowserWindow {
  if (hub && !hub.isDestroyed()) {
    if (hub.isMinimized()) hub.restore();
    hub.show();
    app.focus({ steal: true });
    return hub;
  }

  hub = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 560,
    minHeight: 420,
    show: false,
    title: 'Speech',
    backgroundColor: '#f5f4f0',
    titleBarStyle: 'hiddenInset',
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

  void win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}
