import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';

// Icono en la barra de menús. Clic: abre el Hub. Clic secundario: menú.
// Un aviso (por ejemplo, atajo bloqueado) se muestra en la ayuda y como
// primera línea del menú.

let tray: Tray | null = null;
let openHub: () => void = () => {};
let warning: string | null = null;

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
  tray?.setToolTip(text ? `Speech — ${text}` : 'Speech');
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    ...(warning ? [{ label: warning, enabled: false }, { type: 'separator' as const }] : []),
    { label: 'Open Speech', click: openHub },
    { type: 'separator' },
    { label: 'Quit Speech', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}
