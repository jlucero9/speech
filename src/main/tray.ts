import { app, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';

// Icono en la barra de menús. Clic: abre el Hub. Clic secundario: menú.

let tray: Tray | null = null;

export function createTray(onOpen: () => void): Tray {
  // Imagen de plantilla: macOS la pinta en blanco o negro según la barra.
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png'));
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Speech');

  const menu = Menu.buildFromTemplate([
    { label: 'Open Speech', click: onOpen },
    { type: 'separator' },
    { label: 'Quit Speech', accelerator: 'Command+Q', click: () => app.quit() },
  ]);

  tray.on('click', onOpen);
  tray.on('right-click', () => tray?.popUpContextMenu(menu));
  return tray;
}
