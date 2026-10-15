import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';

// Icono en la barra de menús. Clic: abre el Hub. Clic secundario: menú.
// Un aviso (por ejemplo, atajo bloqueado) y un estado (la descarga del modelo)
// se muestran en la ayuda y como primeras líneas del menú.

let tray: Tray | null = null;
let openHub: () => void = () => {};
let warning: string | null = null;
let status: string | null = null;

export function createTray(onOpen: () => void): Tray {
  openHub = onOpen;
  // Imagen de plantilla: macOS la pinta en blanco o negro según la barra.
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png'));
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Speech');
  tray.on('click', onOpen);
  tray.on('right-click', () => tray?.popUpContextMenu(buildMenu()));
  return tray;
}

export function setTrayWarning(text: string | null): void {
  warning = text;
  updateToolTip();
}

export function setTrayStatus(text: string | null): void {
  if (text === status) return;
  status = text;
  updateToolTip();
}

function updateToolTip(): void {
  const lines = [warning, status].filter(Boolean);
  tray?.setToolTip(lines.length ? `Speech — ${lines.join('\n')}` : 'Speech');
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    ...[warning, status].filter((t): t is string => !!t).map((label) => ({ label, enabled: false })),
    ...(warning || status ? [{ type: 'separator' as const }] : []),
    { label: 'Open Speech', click: openHub },
    { type: 'separator' },
    { label: 'Quit Speech', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}
