import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import type { HubPage } from '../shared/ipc';
import { microphoneChoices } from '../shared/microphones';
import { ANY_SIDE, firstBinding, keyLabel, type ShortcutBinding } from '../shared/shortcuts';
import type { SharedState } from '../shared/state';
import { DICTATION_LANGUAGES } from '../shared/transcription';

// Icono en la barra de menús. Clic (normal o secundario): el menú, como el de
// cualquier icono de la barra de menús. Un aviso (por ejemplo, atajo
// bloqueado) y un estado (la descarga del modelo) se muestran en la ayuda y
// como primeras líneas del menú.

export interface TrayActions {
  openHub(page?: HubPage): void;
  state(): SharedState;
  /** Texto del último dictado, o null si no hay. */
  lastTranscript(): string | null;
  pasteLast(): void;
  setMicrophone(id: string, label: string): void;
  setLanguage(code: string): void;
}

/** Caracteres del último dictado que se ven bajo «Paste last transcript». */
const PREVIEW_CHARS = 26;

let tray: Tray | null = null;
let actions: TrayActions | null = null;
let warning: string | null = null;
let status: string | null = null;

export function createTray(a: TrayActions): Tray {
  actions = a;
  // Imagen de plantilla: macOS la pinta en blanco o negro según la barra.
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'trayTemplate.png'));
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Speech');
  // El menú se construye al abrirlo: así enseña el último dictado y el micrófono de ahora.
  const open = (): void => tray?.popUpContextMenu(buildMenu());
  tray.on('click', open);
  tray.on('right-click', open);
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

/**
 * El atajo como lo escribe un menú de macOS (solo para mostrarlo: lo atiende
 * el helper). Sin él si lleva fn o una tecla de un lado concreto, que un menú
 * no sabe pintar.
 */
function accelerator(binding: ShortcutBinding | null): string | undefined {
  if (!binding) return undefined;
  const mods: Record<number, string> = {
    [ANY_SIDE.control]: 'Control',
    [ANY_SIDE.option]: 'Alt',
    [ANY_SIDE.shift]: 'Shift',
    [ANY_SIDE.command]: 'Command',
  };
  const parts: string[] = [];
  for (const k of binding.keys) {
    if (mods[k]) {
      parts.push(mods[k]);
      continue;
    }
    const label = keyLabel(k, binding.names);
    if (label.length !== 1) return undefined;
    parts.push(label.toUpperCase());
  }
  return parts.join('+');
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS).trimEnd()}...` : flat;
}

function buildMenu(): Menu {
  const a = actions!;
  const s = a.state();
  const last = a.lastTranscript();

  const { choices, selectedKey } = microphoneChoices(s.prefs, s.microphones);
  const microphones: MenuItemConstructorOptions[] = choices.map((c) => ({
    label: c.title,
    type: 'checkbox',
    checked: c.key === selectedKey,
    click: () => a.setMicrophone(c.key, c.device?.label ?? ''),
  }));
  const languages: MenuItemConstructorOptions[] = Object.entries(DICTATION_LANGUAGES).map(([code, name]) => ({
    label: name,
    type: 'checkbox',
    checked: code === s.prefs.dictationLanguage,
    click: () => a.setLanguage(code),
  }));

  return Menu.buildFromTemplate([
    ...[warning, status].filter((t): t is string => !!t).map((label) => ({ label, enabled: false })),
    ...(warning || status ? [{ type: 'separator' as const }] : []),
    { label: 'Open Speech', click: () => a.openHub() },
    { type: 'separator' },
    {
      label: 'Paste last transcript',
      enabled: !!last,
      accelerator: accelerator(firstBinding(s.prefs.shortcuts, 'paste_last')),
      registerAccelerator: false,
      click: () => a.pasteLast(),
    },
    ...(last ? [{ label: preview(last), enabled: false, toolTip: last }] : []),
    { type: 'separator' },
    { label: 'Shortcuts', click: () => a.openHub('settings/shortcuts') },
    { label: 'Microphone', submenu: microphones },
    { label: 'Languages', submenu: languages },
    { type: 'separator' },
    { label: 'Quit Speech', accelerator: 'Command+Q', click: () => app.quit() },
  ]);
}

/** Solo para comprobaciones desde el inspector: el menú tal como saldría ahora. */
export function describeTrayMenu(): unknown {
  const walk = (m: Menu): unknown[] =>
    m.items.map((i) => ({
      label: i.label || `(${i.type})`,
      enabled: i.enabled,
      ...(i.checked ? { checked: true } : {}),
      ...(i.accelerator ? { accelerator: i.accelerator } : {}),
      ...(i.submenu ? { submenu: walk(i.submenu) } : {}),
    }));
  return walk(buildMenu());
}
