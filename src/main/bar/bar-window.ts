import { BrowserWindow, ipcMain, screen, type Display, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import type { BarEdge, BarSound } from '../../shared/bar';
import { BAR_IPC, type BarCommand, type BarDrag } from '../../shared/ipc';
import { logger } from '../log';

// La barra flotante: un panel transparente, siempre encima (también de las
// apps a pantalla completa y en todos los escritorios), que no se activa al
// hacer clic, así que el foco se queda en el campo donde se va a pegar.
//
// La ventana es mayor que la píldora: el resto es sitio para la ayuda y los
// avisos. Por defecto deja pasar el ratón (y reenvía su movimiento a la
// página); la página pide recibir clics mientras el cursor está sobre una
// zona activa. No decide nada: pinta el estado que le llega de main y le
// devuelve los clics.
//
// El menú contextual se pinta en esta misma ventana (sin otra ventana viva).
// Mientras está abierto, la ventana ocupa toda el área útil y recibe todos los
// clics, así que uno fuera del menú lo cierra; la píldora no se mueve porque
// está anclada al centro del borde.

const log = logger('bar');

/** Tamaño de la ventana, en puntos, anclada abajo y en un lateral. */
const BOTTOM_SIZE = { width: 512, height: 320 };
const SIDE_SIZE = { width: 480, height: 512 };
const RECREATE_DELAY_MS = 1_000;

interface PanelModule {
  preventActivation(handle: Buffer): string;
}

/**
 * Impide que un clic en la barra active Speech. Electron no lo consigue solo
 * con `type: 'panel'`: sin esto, el teclado dejaría de ir a la app donde se
 * escribe en cuanto se pulsa la barra.
 */
function preventActivation(win: BrowserWindow): void {
  let result: string;
  try {
    const mod = require(join(__dirname, '..', 'native', 'panel.node')) as PanelModule;
    result = mod.preventActivation(win.getNativeWindowHandle());
  } catch (err) {
    result = `module failed: ${(err as Error).message}`;
  }
  if (result === 'applied') log.info('Bar panel will not activate the app');
  else log.warn(`Bar panel may take focus when clicked (${result})`);
}

export interface BarHandlers {
  command(c: BarCommand): void;
  /** La barra se soltó tras arrastrarla: el borde más cercano al cursor. */
  dropped(edge: BarEdge): void;
  /** ¿Se puede abrir el menú ahora? (no durante un dictado) */
  canOpenMenu(): boolean;
}

export class BarWindow {
  private win: BrowserWindow | null = null;
  private edge: BarEdge;
  private display: Display | null = null;
  /** Desde la esquina de la ventana hasta el cursor, al empezar a arrastrar. */
  private grab: { dx: number; dy: number } | null = null;
  private interactive = false;
  private menuOpen = false;
  private stopped = false;

  constructor(
    edge: BarEdge,
    private readonly handlers: BarHandlers,
  ) {
    this.edge = edge;
    ipcMain.on(BAR_IPC.interactive, (e, on: boolean) => {
      if (this.fromBar(e)) this.setInteractive(on === true);
    });
    ipcMain.on(BAR_IPC.command, (e, c: BarCommand) => {
      if (!this.fromBar(e)) return;
      if (c.type === 'menu') this.openMenu();
      else if (c.type === 'menu-closed') this.closeMenu('closed');
      else this.handlers.command(c);
    });
    ipcMain.on(BAR_IPC.drag, (e, d: BarDrag) => {
      if (this.fromBar(e)) this.onDrag(d);
    });
    const reposition = (): void => this.place(this.currentDisplay());
    screen.on('display-added', reposition);
    screen.on('display-removed', reposition);
    screen.on('display-metrics-changed', reposition);
  }

  get contents(): Electron.WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  create(): void {
    if (this.win && !this.win.isDestroyed()) return;
    const win = new BrowserWindow({
      ...this.size(),
      show: false,
      // Panel no activante: un clic no saca al usuario de su app.
      type: 'panel',
      focusable: false,
      acceptFirstMouse: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hiddenInMissionControl: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'bar.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        webgl: false,
        enableWebSQL: false,
        // Oculta tras otra ventana o no, la barra tiene que animarse a tiempo.
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    this.win = win;
    this.menuOpen = false;
    this.mouseApplied = null;
    preventActivation(win);
    // Por encima de las apps a pantalla completa y del Dock.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.interactive = true;
    this.setInteractive(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error(`Bar process gone (${details.reason}, code ${details.exitCode})`);
      if (!win.isDestroyed()) win.destroy();
    });
    win.on('closed', () => {
      if (this.win !== win) return;
      this.win = null;
      if (!this.stopped) setTimeout(() => this.create(), RECREATE_DELAY_MS);
    });
    win.once('ready-to-show', () => {
      this.place(this.currentDisplay());
      win.showInactive();
      log.info(`Bar shown (${this.edge}, pid ${win.webContents.getOSProcessId()})`);
    });
    void win.loadFile(join(__dirname, '..', 'renderer', 'bar', 'index.html'));
  }

  shutdown(): void {
    this.stopped = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  setEdge(edge: BarEdge): void {
    if (edge === this.edge) return;
    this.edge = edge;
    this.place(this.currentDisplay());
  }

  /** Lleva la barra a la pantalla donde está el cursor (al empezar a dictar). */
  followCursor(): void {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    if (d.id !== this.display?.id) this.place(d);
  }

  sound(s: BarSound): void {
    this.contents?.send(BAR_IPC.sound, s);
  }

  private size(): { width: number; height: number } {
    return this.edge === 'bottom' ? BOTTOM_SIZE : SIDE_SIZE;
  }

  get isMenuOpen(): boolean {
    return this.menuOpen;
  }

  private openMenu(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || this.menuOpen || this.grab || !this.handlers.canOpenMenu()) return;
    this.menuOpen = true;
    this.place(this.currentDisplay());
    this.applyMouse();
    win.webContents.send(BAR_IPC.menu, true);
  }

  /** También desde main: un dictado que empieza cierra el menú. */
  closeMenu(why: string): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    log.info(`Bar menu closed (${why})`);
    this.contents?.send(BAR_IPC.menu, false);
    this.place(this.currentDisplay());
    this.applyMouse();
  }

  private currentDisplay(): Display {
    const all = screen.getAllDisplays();
    return all.find((d) => d.id === this.display?.id) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  /** Centra la ventana en el borde elegido del área útil (sin Dock ni barra de menús). */
  private place(display: Display): void {
    this.display = display;
    const win = this.win;
    if (!win || win.isDestroyed() || this.grab) return;
    const wa = display.workArea;
    if (this.menuOpen) {
      win.setBounds(wa);
      return;
    }
    const { width, height } = this.size();
    const x =
      this.edge === 'bottom'
        ? wa.x + Math.round((wa.width - width) / 2)
        : this.edge === 'left'
          ? wa.x
          : wa.x + wa.width - width;
    const y = this.edge === 'bottom' ? wa.y + wa.height - height : wa.y + Math.round((wa.height - height) / 2);
    win.setBounds({ x, y, width, height });
  }

  private setInteractive(on: boolean): void {
    this.interactive = on;
    this.applyMouse();
  }

  private mouseApplied: boolean | null = null;

  /** Con el menú abierto, la ventana recibe todos los clics. */
  private applyMouse(): void {
    const on = this.interactive || this.menuOpen;
    if (on === this.mouseApplied || !this.win || this.win.isDestroyed()) return;
    this.mouseApplied = on;
    // Sin clics, la página sigue recibiendo el movimiento del ratón para saber
    // cuándo vuelve a estar sobre una zona activa.
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  /** Arrastre: la ventana sigue al cursor y, al soltar, se ancla al borde más cercano. */
  private onDrag(d: BarDrag): void {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (d.phase === 'start') {
      const b = win.getBounds();
      this.grab = { dx: d.x - b.x, dy: d.y - b.y };
      return;
    }
    if (!this.grab) return;
    if (d.phase === 'move') {
      win.setPosition(Math.round(d.x - this.grab.dx), Math.round(d.y - this.grab.dy));
      return;
    }
    this.grab = null;
    const display = screen.getDisplayNearestPoint({ x: Math.round(d.x), y: Math.round(d.y) });
    const edge = nearestEdge(display, d.x, d.y);
    log.info(`Bar dropped on display ${display.id}, ${edge} edge`);
    this.display = display;
    if (edge === this.edge) this.place(display);
    this.handlers.dropped(edge);
  }

  private fromBar(e: IpcMainEvent): boolean {
    return e.sender === this.contents;
  }
}

/** Abajo, izquierda o derecha: el borde del área útil más cercano al punto. */
function nearestEdge(display: Display, x: number, y: number): BarEdge {
  const wa = display.workArea;
  const distances: [BarEdge, number][] = [
    ['bottom', wa.y + wa.height - y],
    ['left', x - wa.x],
    ['right', wa.x + wa.width - x],
  ];
  return distances.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
}
