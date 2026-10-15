import { app, ipcMain, powerMonitor, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { IPC } from '../shared/ipc';
import { isValidPreference, type Preferences } from '../shared/preferences';
import { DEFAULT_SHORTCUTS } from '../shared/shortcuts';
import { DEFAULT_LOCAL_MODEL, type ModelState } from '../shared/transcription';
import { openDatabase } from './db';
import { Dictation } from './dictation/dictation';
import { ShortcutListener } from './dictation/shortcuts';
import { HelperProcess } from './helper/helper-process';
import { History } from './history';
import { openHub } from './hub-window';
import { appPids, KeyboardStatus } from './keyboard-status';
import { logger } from './log';
import { helperExecutable, transcriberExecutable } from './paths';
import { Permissions } from './permissions';
import { loadPreferences, savePreferences } from './preferences';
import { RecorderWindow } from './recorder-window';
import { initialState, Store } from './store';
import { LocalWhisper } from './transcription/local-whisper';
import { ModelManager } from './transcription/models';
import { createTray, setTrayStatus, setTrayWarning } from './tray';

const log = logger('main');

app.setName('Speech');
// El servicio de audio de Chromium va por defecto en un proceso propio que,
// una vez abierto el micrófono, ya no se cierra. Dentro de main ocupa mucho
// menos y la captura solo se usa durante el dictado.
app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');

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
  const keyboard = new KeyboardStatus(store, helper, appPids, () => DEFAULT_SHORTCUTS, (owner) =>
    setTrayWarning(owner ? `Shortcut blocked by secure input in ${owner.appName ?? 'another app'}` : null),
  );

  // Historial
  const recordingsDir = join(dataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  const history = db ? new History(db, recordingsDir) : null;
  try {
    history?.tidy();
  } catch (err) {
    log.error('Could not tidy the history', err);
  }
  const vocabulary = (): string[] => {
    if (!db) return [];
    try {
      return db
        .prepare('SELECT phrase FROM dictionary WHERE replacement IS NULL ORDER BY is_starred DESC, updated_at DESC')
        .all()
        .map((r) => String(r.phrase));
    } catch (err) {
      log.warn(`Could not read the dictionary: ${(err as Error).message}`);
      return [];
    }
  };

  // Transcripción: el modelo se descarga la primera vez; desde entonces, sin red.
  const models = new ModelManager(store, join(dataDir, 'models'), DEFAULT_LOCAL_MODEL);
  const engine = new LocalWhisper(store, models, transcriberExecutable());
  models.start();
  // El modelo se avisa en la bandeja mientras se descarga.
  store.subscribe((s) => setTrayStatus(modelTrayText(s.transcription.model)));

  // Atajo y dictado. La ventana de grabación vive siempre (oculta).
  const recorder = new RecorderWindow();
  recorder.installPermissionHandlers();
  recorder.create();
  const shortcuts = new ShortcutListener(helper, DEFAULT_SHORTCUTS);
  const dictation = new Dictation(
    store,
    helper,
    recorder,
    permissions,
    shortcuts,
    recordingsDir,
    engine,
    history,
    vocabulary,
  );

  helper.start();
  powerMonitor.on('resume', () => helper.noteResume());
  // Dormido no se dicta: el modelo no tiene por qué seguir ocupando memoria.
  powerMonitor.on('suspend', () => engine.release('system sleep'));

  const showHub = (): void => {
    openHub(() => {
      permissions.refreshMicrophone();
      void keyboard.refresh();
    });
  };
  createTray(showHub);
  app.on('second-instance', showHub);
  // Una app de la barra de menús sigue viva sin ventanas.
  app.on('window-all-closed', () => {});

  // IPC
  ipcMain.handle(IPC.getState, (e) => {
    store.addTarget(e.sender);
    return store.get();
  });
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
  ipcMain.handle(IPC.requestInputMonitoring, () => keyboard.requestInputMonitoring());
  ipcMain.handle(IPC.openInputMonitoringSettings, () => keyboard.openInputMonitoringSettings());
  ipcMain.handle(IPC.openKeyboardSettings, () => keyboard.openKeyboardSettings());
  ipcMain.handle(IPC.revealRecording, (_e, id?: string) => {
    const file = id ? history?.audioPath(String(id)) : store.get().dictation.last?.file;
    if (file) shell.showItemInFolder(file);
  });
  ipcMain.handle(IPC.downloadModel, () => models.download());
  ipcMain.handle(IPC.listHistory, (_e, limit: number) => history?.recent(Number(limit) || 20) ?? []);

  app.on('before-quit', () => {
    log.info('Quitting');
    helper.stop();
    recorder.shutdown();
    models.stop();
    engine.release('quitting');
    db?.close();
    db = null;
  });

  // Solo para comprobaciones desde el inspector de main (npm run start:debug).
  if (process.env.SPEECH_DEBUG === '1') {
    (globalThis as Record<string, unknown>).speechDebug = {
      store,
      helper,
      permissions,
      keyboard,
      recorder,
      shortcuts,
      dictation,
      history,
      models,
      engine,
      showHub,
      dataDir,
    };
  }
}

function modelTrayText(m: ModelState): string | null {
  switch (m.status) {
    case 'downloading':
    case 'verifying': {
      const pct = m.totalBytes ? Math.floor((m.receivedBytes / m.totalBytes) * 100) : 0;
      return `Downloading the speech model… ${pct}%`;
    }
    case 'failed':
      return 'The speech model could not be downloaded';
    default:
      return null;
  }
}
