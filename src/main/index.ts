import { app, ipcMain, powerMonitor } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { IPC } from '../shared/ipc';
import { isValidPreference, type Preferences } from '../shared/preferences';
import { openDatabase } from './db';
import { HelperProcess } from './helper/helper-process';
import { openHub } from './hub-window';
import { logger } from './log';
import { helperExecutable } from './paths';
import { Permissions } from './permissions';
import { loadPreferences, savePreferences } from './preferences';
import { initialState, Store } from './store';
import { createTray } from './tray';

const log = logger('main');

app.setName('Speech');

if (!app.requestSingleInstanceLock()) {
  // Ya hay una instancia: ella abre su ventana (evento second-instance).
  app.quit();
} else {
  // Sin icono en el Dock. En el bundle también lo garantiza LSUIElement.
  app.dock?.hide();
  void app.whenReady().then(main);
}

function main(): void {
  log.info(`Starting Speech ${app.getVersion()} (Electron ${process.versions.electron}, pid ${process.pid})`);
  const store = new Store(initialState());
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });

  // Preferencias
  const prefsPath = join(dataDir, 'preferences.json');
  const prefs = loadPreferences(prefsPath);
  store.update((s) => ({ ...s, prefs }));

  // Base de datos
  let db: DatabaseSync | null = null;
  try {
    const opened = openDatabase(join(dataDir, 'speech.sqlite'));
    db = opened.db;
    store.update((s) => ({
      ...s,
      data: {
        databaseReady: true,
        schemaVersion: opened.schemaVersion,
        migrationsAppliedThisLaunch: opened.appliedThisLaunch,
        error: null,
      },
    }));
  } catch (err) {
    log.error('Could not open the database', err);
    store.update((s) => ({ ...s, data: { ...s.data, databaseReady: false, error: (err as Error).message } }));
  }

  // Helper y permisos
  const helper = new HelperProcess(helperExecutable());
  helper.on('state', (h) => store.update((s) => ({ ...s, helper: h })));
  const permissions = new Permissions(store, helper);
  permissions.refreshMicrophone();
  helper.start();
  powerMonitor.on('resume', () => helper.noteResume());

  const showHub = (): void => {
    openHub(() => permissions.refreshMicrophone());
  };
  createTray(showHub);
  app.on('second-instance', showHub);
  // Una app de la barra de menús sigue viva sin ventanas.
  app.on('window-all-closed', () => {});

  // IPC
  ipcMain.handle(IPC.getState, () => store.get());
  ipcMain.handle(IPC.setPreference, (_e, key: keyof Preferences, value: unknown) => {
    if (!isValidPreference(key, value)) throw new Error(`Invalid preference ${String(key)}`);
    const next = { ...store.get().prefs, [key]: value };
    savePreferences(prefsPath, next);
    store.update((s) => ({ ...s, prefs: next }));
    log.info(`Preference ${key} = ${JSON.stringify(value)}`);
  });
  ipcMain.handle(IPC.requestAccessibility, () => permissions.requestAccessibility());
  ipcMain.handle(IPC.requestMicrophone, () => permissions.requestMicrophone());
  ipcMain.handle(IPC.openAccessibilitySettings, () => permissions.openAccessibilitySettings());
  ipcMain.handle(IPC.retryHelper, () => helper.retry());

  app.on('before-quit', () => {
    log.info('Quitting');
    helper.stop();
    db?.close();
    db = null;
  });

  // Solo para comprobaciones desde el inspector de main (npm run start:debug).
  if (process.env.SPEECH_DEBUG === '1') {
    (globalThis as Record<string, unknown>).speechDebug = { store, helper, permissions, showHub, dataDir };
  }
}
