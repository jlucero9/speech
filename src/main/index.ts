import { app, clipboard, dialog, ipcMain, nativeTheme, powerMonitor, shell } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HUB_EVENTS, IPC, type BarMenuItem, type HubPage } from '../shared/ipc';
import { shownText, type HistoryActionResult } from '../shared/history';
import type { DictionaryImportChoice, DictionaryInput, DictionaryResult } from '../shared/dictionary';
import type { BarSound, NoticeAction } from '../shared/bar';
import { isCloudProvider, type CloudProvider } from '../shared/engines';
import { isValidPreference, type Preferences } from '../shared/preferences';
import { compactLabel, firstBinding, type ShortcutBinding } from '../shared/shortcuts';
import { DEFAULT_LOCAL_MODEL, type ModelState } from '../shared/transcription';
import { BarWindow } from './bar/bar-window';
import { notice, setNoticeShortcuts } from './bar/notice-texts';
import { Notices } from './bar/notices';
import { isDamage, openChecked, repairDatabase, watchForDamage, type RepairResult } from './db/repair';
import { Dictation, type DictationWords } from './dictation/dictation';
import { Dictionary } from './dictionary';
import { Paster } from './dictation/paste';
import { ShortcutListener } from './dictation/shortcuts';
import { VoiceLevels } from './dictation/voice';
import { HelperProcess } from './helper/helper-process';
import { scheduleDaily } from './daily';
import { History } from './history';
import { hubWindow, openHub, sendToHub } from './hub-window';
import { appPids, KeyboardStatus } from './keyboard-status';
import { ApiKeys } from './keys';
import { logger } from './log';
import { helperExecutable, transcriberExecutable } from './paths';
import { Permissions } from './permissions';
import { defaultPreferences, loadPreferences, savePreferences } from './preferences';
import { RecorderWindow } from './recorder-window';
import { initialState, Store } from './store';
import { TextFormatting } from './formatting/service';
import { TranscriptionEngines } from './transcription/engines';
import { GroqUsage } from './cloud-usage';
import { LocalWhisper } from './transcription/local-whisper';
import { ModelManager } from './transcription/models';
import { createTray, describeTrayMenu, setTrayStatus, setTrayWarning } from './tray';

const log = logger('main');

const MICROPHONE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
const HIDE_BAR_MS = 60 * 60_000;
/** «Auto-delete local data every 24hrs». */
const AUTODELETE_AFTER_MS = 24 * 60 * 60_000;
const AUTODELETE_EVERY_MS = 60 * 60_000;
/** Sin guardar el historial, un cancelado se conserva lo justo para su «Undo». */
const NEVER_STORE_KEEP_CANCELLED_MS = 30_000;

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
  const store = new Store(initialState(app.getVersion()));
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });

  // Preferencias
  const prefsPath = join(dataDir, 'preferences.json');
  const prefs = loadPreferences(prefsPath);
  store.update((s) => ({ ...s, prefs }));
  // El tema se fija en Electron: así las ventanas lo reciben como
  // prefers-color-scheme desde el primer pintado, sin parpadeo.
  nativeTheme.themeSource = prefs.appearance;
  store.subscribe((s) => {
    if (nativeTheme.themeSource !== s.prefs.appearance) nativeTheme.themeSource = s.prefs.appearance;
  });
  const setPreference = <K extends keyof Preferences>(key: K, value: Preferences[K]): void => {
    const next = { ...store.get().prefs, [key]: value };
    savePreferences(prefsPath, next);
    store.update((s) => ({ ...s, prefs: next }));
    log.info(`Preference ${key} = ${JSON.stringify(value)}`);
  };

  // Base de datos. Si está dañada (al arrancar, o porque en marcha SQLite lo
  // dijo y quedó la marca), se repara antes de usarla.
  let db: DatabaseSync | null = null;
  const dbPath = join(dataDir, 'speech.sqlite');
  const repairMark = join(dataDir, 'repair-database');
  let repaired: RepairResult | null = null;
  // Se asigna al crear la barra; hasta entonces no hay dónde avisar.
  let notifyDamage: () => void = () => {};
  try {
    let opened;
    try {
      if (existsSync(repairMark)) throw new Error('database disk image is malformed (marked while running)');
      opened = openChecked(dbPath);
    } catch (err) {
      if (!isDamage(err)) throw err;
      log.error(`The database is damaged: ${(err as Error).message}`);
      repaired = repairDatabase(dbPath);
      opened = repaired.opened;
      rmSync(repairMark, { force: true });
    }
    db = watchForDamage(opened.db, (err) => {
      log.error(`The database reported damage while running: ${err.message}`);
      try {
        writeFileSync(repairMark, `${new Date().toISOString()} ${err.message}\n`);
      } catch (e) {
        log.error('Could not mark the database for repair', e);
      }
      notifyDamage();
    });
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
  const helper = new HelperProcess(helperExecutable(), dataDir);
  helper.on('state', (h) => store.update((s) => ({ ...s, helper: h })));
  const permissions = new Permissions(store, helper);
  permissions.refreshMicrophone();
  const keyboard = new KeyboardStatus(store, helper, appPids, () => store.get().prefs.shortcuts, (owner) =>
    setTrayWarning(owner ? `Shortcut blocked by secure input in ${owner.appName ?? 'another app'}` : null),
  );

  // Historial
  const recordingsDir = join(dataDir, 'recordings');
  mkdirSync(recordingsDir, { recursive: true });
  const history = db ? new History(db, recordingsDir) : null;
  try {
    history?.markInterrupted();
    history?.purgeOldAudio();
  } catch (err) {
    log.error('Could not tidy the history', err);
  }
  // Cada cambio se avisa al Hub, que vuelve a leer la lista. Varios seguidos, juntos.
  let historyChangedTimer: NodeJS.Timeout | null = null;
  history?.onChange(() => {
    historyChangedTimer ??= setTimeout(() => {
      historyChangedTimer = null;
      sendToHub(HUB_EVENTS.historyChanged);
    }, 30);
  });
  scheduleDaily(12, (resume) => powerMonitor.on('resume', resume), () => {
    try {
      history?.purgeOldAudio();
    } catch (err) {
      log.error('Could not delete old audio', err);
    }
  });
  // Diccionario. Si la base falla, se dicta igual, sin él.
  const dictionary = db ? new Dictionary(db) : null;
  dictionary?.onChange(() => sendToHub(HUB_EVENTS.dictionaryChanged));
  const readDictionary = <T>(read: (d: Dictionary) => T, fallback: T): T => {
    if (!dictionary) return fallback;
    try {
      return read(dictionary);
    } catch (err) {
      log.warn(`Could not read the dictionary: ${(err as Error).message}`);
      return fallback;
    }
  };
  const words: DictationWords = {
    terms: () => readDictionary((d) => d.terms(), []),
    spellings: () => readDictionary((d) => d.spellings(), []),
    substitute: (text) => readDictionary((d) => d.substitute(text), { text, count: 0 }),
  };

  // Transcripción: el modelo se descarga la primera vez; desde entonces, sin red.
  const models = new ModelManager(store, join(dataDir, 'models'), DEFAULT_LOCAL_MODEL);
  // Las claves de la nube: al arrancar solo se mira si están, sin leerlas.
  const apiKeys = new ApiKeys(store);
  void apiKeys.refresh();
  const groqUsage = new GroqUsage(store, join(dataDir, 'groq-usage.json'));
  const engine = new TranscriptionEngines(store, new LocalWhisper(store, models, transcriberExecutable()), apiKeys.read, groqUsage);
  models.start();
  // El modelo se avisa en la bandeja mientras se descarga.
  store.subscribe((s) => setTrayStatus(modelTrayText(s.transcription.model)));

  // Atajo y dictado. La ventana de grabación vive siempre (oculta).
  const recorder = new RecorderWindow();
  recorder.installPermissionHandlers();
  recorder.create();
  const shortcuts = new ShortcutListener(helper, store.get().prefs.shortcuts);
  const shortcutLabels = (list: ShortcutBinding[]) => {
    const ptt = firstBinding(list, 'ptt');
    const paste = firstBinding(list, 'paste_last');
    return {
      ptt: ptt ? compactLabel(ptt.keys, ptt.names) : 'fn',
      pasteLast: paste ? compactLabel(paste.keys, paste.names) : null,
    };
  };
  {
    const l = shortcutLabels(store.get().prefs.shortcuts);
    setNoticeShortcuts(l.ptt, l.pasteLast);
  }
  // Micrófonos conectados y nivel del que se prueba en el diálogo de ajustes.
  recorder.on('devices', (devices, systemDefault) => {
    store.update((s) => ({ ...s, microphones: { ...s.microphones, devices, systemDefault } }));
    log.info(`Microphones: ${devices.map((d) => d.label).join(', ') || 'none'} (system default: ${systemDefault ?? '?'})`);
  });
  recorder.on('level', (level) => sendToHub(HUB_EVENTS.microphoneLevel, level));
  const voiceLevels = new VoiceLevels(join(dataDir, 'voice-levels.json'));
  const paster = new Paster(helper);
  // Formateo: Ollama en el equipo por defecto; si no responde, se pega la transcripción.
  const formatting = new TextFormatting(store, apiKeys.read, groqUsage);
  void formatting.check();

  // Barra flotante: siempre viva; sus avisos y sonidos los decide main.
  let dictation: Dictation | null = null;
  const showHub = (page: HubPage = 'dictation'): void => {
    openHub(page, () => {
      permissions.refreshMicrophone();
      void keyboard.refresh();
      // Ollama se arranca y se para por fuera: que el Hub no enseñe un estado viejo.
      void formatting.check();
      void apiKeys.refresh();
    });
  };
  const playSound = (sound: BarSound): void => {
    if (store.get().prefs.enableSounds) bar.sound(sound);
  };
  const notices = new Notices(store, playSound);
  const runNoticeAction = (id: number, action: NoticeAction): void => {
    const n = notices.current;
    if (n?.id !== id) return;
    if (action === 'copy_text') {
      // La barra enseña «Copied!» y cierra el aviso ella misma.
      if (n.body) clipboard.writeText(n.body);
      log.info(`Notice ${id}: copied ${n.body?.length ?? 0} chars`);
      return;
    }
    notices.close(id, `action ${action}`);
    switch (action) {
      case 'undo_cancel':
        if (n.dictationId) void dictation?.recover(n.dictationId);
        break;
      case 'open_hub':
        showHub('settings/system');
        break;
      case 'open_engines':
        showHub('settings/engines');
        break;
      case 'open_history':
        showHub('dictation');
        break;
      case 'open_microphone_settings':
        void shell.openExternal(MICROPHONE_SETTINGS_URL);
        break;
      case 'show_bar':
        setPreference('barHiddenUntil', 0);
        break;
      case 'restart_app':
        log.info('Restarting to repair the database');
        app.relaunch();
        app.quit();
        break;
    }
  };
  const bar = new BarWindow(store.get().prefs.barEdge, {
    command: (c) => {
      switch (c.type) {
        case 'start':
          return dictation?.startFromBar();
        case 'stop':
          return dictation?.stopFromBar();
        case 'cancel':
          return dictation?.cancelFromBar();
        case 'notice-action':
          return runNoticeAction(c.id, c.action);
        case 'notice-closed':
          return notices.close(c.id, c.why);
        case 'menu-item':
          return runMenuItem(c.item);
        case 'set-microphone': {
          const id = typeof c.id === 'string' ? c.id : '';
          const label = typeof c.label === 'string' ? c.label : '';
          if (!isValidPreference('microphoneId', id) || !isValidPreference('microphoneLabel', label)) return;
          setPreference('microphoneId', id);
          setPreference('microphoneLabel', label);
          return;
        }
      }
    },
    dropped: (edge) => {
      if (edge !== store.get().prefs.barEdge) setPreference('barEdge', edge);
    },
    canOpenMenu: () => !dictation?.inProgress,
  });
  // El menú contextual de la barra (se pinta en la propia barra).
  function runMenuItem(item: BarMenuItem): void {
    bar.closeMenu(`chose ${item}`);
    switch (item) {
      case 'hide':
        setPreference('barHiddenUntil', Date.now() + HIDE_BAR_MS);
        notices.show(notice.barHidden());
        break;
      case 'settings':
        showHub('settings');
        break;
      case 'history':
        showHub('dictation');
        break;
      case 'paste_last':
        dictation?.pasteLastFromMenu();
        break;
    }
  }
  // Un dictado que empieza cierra el menú.
  store.subscribe((s) => {
    if (s.dictation.status !== 'idle' && bar.isMenuOpen) bar.closeMenu('dictation started');
  });
  bar.create();
  notifyDamage = () => notices.show(notice.databaseDamaged());
  if (repaired) {
    const n = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    const r = repaired;
    // Cuando la barra ya pinta.
    setTimeout(() => notices.show(notice.databaseRepaired(n(r.recovered), n(r.lost))), 1_500);
  }
  // Al cambiar el borde, la ventana cambia de forma; al ocultarla una hora, vuelve sola.
  let hideTimer: NodeJS.Timeout | null = null;
  const syncBarPrefs = (p: Preferences): void => {
    bar.setEdge(p.barEdge);
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (p.barHiddenUntil > 0) {
      const left = p.barHiddenUntil - Date.now();
      if (left <= 0) setPreference('barHiddenUntil', 0);
      else hideTimer = setTimeout(() => setPreference('barHiddenUntil', 0), left);
    }
  };
  // Lo que no lee cada pieza por su cuenta se aplica aquí al cambiar, sin reiniciar.
  const applySystem = (p: Preferences, prev: Preferences | null): void => {
    if (!prev || p.showInDock !== prev.showInDock) {
      if (p.showInDock) void app.dock?.show();
      else app.dock?.hide();
    }
    if (prev && p.launchAtLogin !== prev.launchAtLogin) {
      app.setLoginItemSettings({ openAtLogin: p.launchAtLogin });
      log.info(`Launch at login: ${app.getLoginItemSettings().openAtLogin}`);
    }
  };
  let lastPrefs = store.get().prefs;
  syncBarPrefs(lastPrefs);
  applySystem(lastPrefs, null);
  // Abrir al iniciar sesión lo guarda macOS: la preferencia es su reflejo.
  const loginItem = app.getLoginItemSettings().openAtLogin;
  if (loginItem !== lastPrefs.launchAtLogin) {
    setPreference('launchAtLogin', loginItem);
    lastPrefs = store.get().prefs;
  }
  store.subscribe((s) => {
    if (s.prefs === lastPrefs) return;
    const prev = lastPrefs;
    lastPrefs = s.prefs;
    if (s.prefs.barEdge !== prev.barEdge || s.prefs.barHiddenUntil !== prev.barHiddenUntil) syncBarPrefs(s.prefs);
    if (s.prefs.shortcuts !== prev.shortcuts) {
      shortcuts.setShortcuts(s.prefs.shortcuts);
      const l = shortcutLabels(s.prefs.shortcuts);
      setNoticeShortcuts(l.ptt, l.pasteLast);
      void keyboard.refresh();
    }
    if (s.prefs.historyStorage !== prev.historyStorage) applyHistoryStorage(s.prefs.historyStorage, 'changed');
    applySystem(s.prefs, prev);
  });

  dictation = new Dictation(
    store,
    helper,
    recorder,
    permissions,
    shortcuts,
    recordingsDir,
    engine,
    history,
    words,
    paster,
    formatting,
    {
      sound: playSound,
      notify: (n) => notices.show(n),
      clearNotice: () => {
        const n = notices.current;
        if (n) notices.close(n.id, 'new dictation');
      },
      followCursor: () => bar.followCursor(),
      pttLabel: () => shortcutLabels(store.get().prefs.shortcuts).ptt,
      microphoneUsed: (label) => {
        if (store.get().microphones.lastUsed !== label) {
          store.update((s) => ({ ...s, microphones: { ...s.microphones, lastUsed: label } }));
        }
      },
      concluded: (id, outcome) => {
        // Sin guardar el historial: el dictado se borra en cuanto termina (un
        // cancelado, cuando ya no se puede deshacer).
        if (store.get().prefs.historyStorage !== 'never') return;
        const drop = () => {
          if (store.get().prefs.historyStorage === 'never') history?.delete(id);
        };
        if (outcome === 'cancelled') setTimeout(drop, NEVER_STORE_KEEP_CANCELLED_MS);
        else drop();
      },
    },
    voiceLevels,
  );

  // Cuánto se guarda del historial. Al elegir «nunca», se borra todo lo que hay
  // (el Hub pide confirmación antes); con «24 horas», lo anterior.
  function applyHistoryStorage(mode: Preferences['historyStorage'], why: string): void {
    if (!history || mode === 'store') return;
    try {
      const cutoff = mode === 'never' ? Date.now() + 1 : Date.now() - AUTODELETE_AFTER_MS;
      const n = history.deleteBefore(cutoff);
      log.info(`History storage "${mode}" (${why}): deleted ${n} dictations`);
    } catch (err) {
      log.error('Could not delete old dictations', err);
    }
  }
  applyHistoryStorage(store.get().prefs.historyStorage, 'startup');
  setInterval(() => {
    if (store.get().prefs.historyStorage === 'autodelete') applyHistoryStorage('autodelete', 'hourly');
  }, AUTODELETE_EVERY_MS).unref();
  powerMonitor.on('resume', () => {
    if (store.get().prefs.historyStorage === 'autodelete') applyHistoryStorage('autodelete', 'resume');
  });

  helper.start();
  /** Cuando no haya ningún dictado en marcha (ya, si no lo hay). */
  const whenDictationIdle = (fn: () => void): void => {
    if (!dictation?.inProgress) return fn();
    const off = store.subscribe((s) => {
      if (s.dictation.status !== 'idle') return;
      off();
      fn();
    });
  };
  powerMonitor.on('resume', () => {
    log.info('System resumed');
    helper.noteResume();
    // Ollama pudo cerrarse o reiniciarse mientras dormía.
    void formatting.check();
  });
  // Dormido no se dicta: los modelos no tienen por qué seguir ocupando memoria.
  // Una grabación en marcha se para y se guarda; lo que se esté transcribiendo
  // termina al despertar, y entonces se sueltan.
  powerMonitor.on('suspend', () => {
    log.info('System going to sleep');
    dictation?.systemWillSleep();
    engine.release('system sleep', true);
    whenDictationIdle(() => formatting.release('system sleep'));
  });
  // Poca memoria libre. En «warning» (frecuente en un equipo de 8 GB con
  // varias apps abiertas) se suelta el modelo de formateo de Ollama, el mayor
  // y el único opcional, en cuanto no se use. En «critical» también whisper
  // (~0,7 GB), y el formateo local se salta hasta que pase. El siguiente
  // dictado vuelve a cargar lo que haga falta.
  let memoryPressure = 'normal';
  helper.on('memoryPressure', (level) => {
    if (level === memoryPressure) return;
    log.info(`Memory pressure ${memoryPressure} → ${level}`);
    memoryPressure = level;
    formatting.setLowMemory(level === 'critical');
    if (level === 'normal') return;
    whenDictationIdle(() => formatting.release(`memory pressure ${level}`));
    if (level === 'critical') engine.release(`memory pressure ${level}`, true);
  });

  createTray({
    openHub: (page) => showHub(page),
    state: () => store.get(),
    lastTranscript: () => dictation?.lastTranscript() ?? null,
    pasteLast: () => dictation?.pasteLastFromMenu(),
    setMicrophone: (id, label) => {
      if (!isValidPreference('microphoneId', id) || !isValidPreference('microphoneLabel', label)) return;
      setPreference('microphoneId', id);
      setPreference('microphoneLabel', label);
    },
    setLanguage: (code) => {
      if (isValidPreference('dictationLanguage', code)) setPreference('dictationLanguage', code);
    },
  });
  app.on('second-instance', () => showHub());
  // Con el icono en el Dock, hacer clic en él abre el Hub.
  app.on('activate', () => showHub());
  // Una app de la barra de menús sigue viva sin ventanas.
  app.on('window-all-closed', () => {});

  // IPC
  ipcMain.handle(IPC.getState, (e) => {
    store.addTarget(e.sender);
    return store.get();
  });
  ipcMain.handle(IPC.setPreference, (_e, key: keyof Preferences, value: unknown) => {
    if (!isValidPreference(key, value)) throw new Error(`Invalid preference ${String(key)}`);
    // Un motor en la nube solo se elige con su clave guardada.
    if ((key === 'transcriptionEngine' || key === 'formattingProvider') && isCloudProvider(value) && store.get().apiKeys[value] !== 'saved') {
      throw new Error(`No key for ${value}`);
    }
    setPreference(key, value);
  });
  ipcMain.handle(IPC.requestAccessibility, () => permissions.requestAccessibility());
  ipcMain.handle(IPC.requestMicrophone, () => permissions.requestMicrophone());
  ipcMain.handle(IPC.openAccessibilitySettings, () => permissions.openAccessibilitySettings());
  ipcMain.handle(IPC.openMicrophoneSettings, () => shell.openExternal(MICROPHONE_SETTINGS_URL));
  ipcMain.handle(IPC.retryHelper, () => helper.retry());
  ipcMain.handle(IPC.requestInputMonitoring, () => keyboard.requestInputMonitoring());
  ipcMain.handle(IPC.openInputMonitoringSettings, () => keyboard.openInputMonitoringSettings());
  ipcMain.handle(IPC.openKeyboardSettings, () => keyboard.openKeyboardSettings());
  ipcMain.handle(IPC.revealRecording, (_e, id?: string) => {
    const file = id ? history?.audioPath(String(id)) : store.get().dictation.last?.file;
    if (file) shell.showItemInFolder(file);
  });
  ipcMain.handle(IPC.downloadModel, () => models.download());
  // Historial (Hub)
  const noHistory: HistoryActionResult = { ok: false, message: 'The history is not available.' };
  ipcMain.handle(IPC.listHistory, (_e, q: unknown) => {
    const query = (q ?? {}) as { limit?: unknown; search?: unknown };
    if (!history) return { entries: [], more: false };
    return history.list({
      limit: Number(query.limit) || 50,
      search: typeof query.search === 'string' ? query.search.slice(0, 200) : undefined,
    });
  });
  ipcMain.handle(IPC.historyStats, () => history?.stats() ?? { totalWords: 0, wpm: null, streakDays: 0 });
  ipcMain.handle(IPC.historyAudio, async (_e, id: unknown) => {
    const file = history?.audioPath(String(id));
    if (!file) return null;
    try {
      return new Uint8Array(await readFile(file));
    } catch (err) {
      log.warn(`Could not read ${file}: ${(err as Error).message}`);
      return null;
    }
  });
  ipcMain.handle(IPC.copyTranscript, (_e, id: unknown): HistoryActionResult => {
    const entry = history?.get(String(id));
    if (!entry) return noHistory;
    const text = shownText(entry)?.trim();
    if (!text) return { ok: false, message: 'Transcript is empty' };
    clipboard.writeText(text);
    return { ok: true };
  });
  ipcMain.handle(IPC.setShowFormatted, (_e, id: unknown, show: unknown) => {
    history?.update(String(id), { showFormatted: show === true });
  });
  ipcMain.handle(IPC.setFlagged, (_e, id: unknown, flagged: unknown) => {
    history?.update(String(id), { flagged: flagged === true });
  });
  ipcMain.handle(IPC.retryTranscript, (_e, id: unknown) => dictation?.retry(String(id)) ?? noHistory);
  ipcMain.handle(IPC.deleteTranscript, (_e, id: unknown): HistoryActionResult => {
    if (!history) return noHistory;
    history.delete(String(id));
    log.info(`Deleted dictation ${String(id).slice(0, 8)} from the history`);
    return { ok: true };
  });
  ipcMain.handle(IPC.extractAudio, async (_e, id: unknown) => {
    const entry = history?.get(String(id));
    const file = entry ? history?.audioPath(entry.id) : null;
    if (!entry || !file) return { ok: false, message: 'Cannot save the audio: it is no longer available (older than 14 days).' };
    const stamp = new Date(entry.createdAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    const name = `Speech ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} at ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}.${pad(stamp.getSeconds())}.wav`;
    const options = {
      title: 'Extract audio',
      defaultPath: join(homedir(), 'Downloads', name),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
    };
    const win = hubWindow();
    const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (r.canceled || !r.filePath) return { ok: true, saved: false };
    try {
      await copyFile(file, r.filePath);
      log.info(`Extracted the audio of ${entry.id.slice(0, 8)}`);
      return { ok: true, saved: true };
    } catch (err) {
      log.error(`Could not copy ${file}`, err);
      return { ok: false, message: 'Could not save the audio.' };
    }
  });

  // Diccionario (Hub)
  const noDictionary: DictionaryResult = { ok: false, message: 'The dictionary is not available.' };
  const toInput = (v: unknown): DictionaryInput => {
    const o = (v ?? {}) as { phrase?: unknown; replacement?: unknown };
    return {
      phrase: typeof o.phrase === 'string' ? o.phrase : '',
      replacement: typeof o.replacement === 'string' ? o.replacement : null,
    };
  };
  ipcMain.handle(IPC.listDictionary, () => dictionary?.list() ?? []);
  ipcMain.handle(IPC.addWord, (_e, input: unknown) => dictionary?.add(toInput(input)) ?? noDictionary);
  ipcMain.handle(IPC.editWord, (_e, id: unknown, input: unknown) => dictionary?.edit(String(id), toInput(input)) ?? noDictionary);
  ipcMain.handle(IPC.removeWords, (_e, ids: unknown) => (Array.isArray(ids) ? (dictionary?.remove(ids.map(String)) ?? 0) : 0));
  ipcMain.handle(IPC.starWord, (_e, id: unknown, starred: unknown) => dictionary?.setStarred(String(id), starred === true));
  ipcMain.handle(IPC.chooseDictionaryFile, async (): Promise<DictionaryImportChoice> => {
    if (!dictionary) return noDictionary;
    const options = {
      title: 'Import words',
      defaultPath: join(homedir(), 'Downloads'),
      properties: ['openFile' as const],
      filters: [{ name: 'Text or CSV', extensions: ['txt', 'csv', 'tsv'] }],
    };
    const win = hubWindow();
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    const file = r.filePaths[0];
    if (r.canceled || !file) return { ok: true, preview: null };
    try {
      return dictionary.preview(basename(file), await readFile(file));
    } catch (err) {
      log.warn(`Could not read ${file}: ${(err as Error).message}`);
      return { ok: false, message: 'Could not read the file.' };
    }
  });
  ipcMain.handle(IPC.restoreWords, (_e, entries: unknown) => {
    if (!Array.isArray(entries) || !dictionary) return 0;
    return dictionary.restore(
      entries.map((v) => {
        const o = (v ?? {}) as Record<string, unknown>;
        return {
          ...toInput(o),
          id: String(o.id),
          starred: o.starred === true,
          createdAt: Number(o.createdAt) || Date.now(),
          updatedAt: Number(o.updatedAt) || Date.now(),
        };
      }),
    );
  });
  ipcMain.handle(IPC.importDictionary, (_e, items: unknown) =>
    Array.isArray(items) ? (dictionary?.import(items.map(toInput)) ?? 0) : 0,
  );

  // Ajustes (Hub)
  // Grabar un atajo: mientras dura, el helper se traga las teclas normales en
  // todo el sistema, así que se para en cuanto el Hub pierde el foco o se cierra.
  shortcuts.on('recording', (r) => sendToHub(HUB_EVENTS.shortcutRecording, r));
  const stopRecordingOnBlur = () => shortcuts.stopRecording('Hub lost focus');
  ipcMain.handle(IPC.recordShortcut, (_e, on: unknown) => {
    const win = hubWindow();
    win?.removeListener('blur', stopRecordingOnBlur);
    win?.removeListener('closed', stopRecordingOnBlur);
    if (on === true && win?.isFocused()) {
      shortcuts.startRecording();
      win.once('blur', stopRecordingOnBlur);
      win.once('closed', stopRecordingOnBlur);
    } else {
      shortcuts.stopRecording(on === true ? 'Hub not focused' : 'done');
    }
  });
  const stopMonitor = () => recorder.monitor(undefined);
  ipcMain.handle(IPC.monitorMicrophone, (_e, device: unknown) => {
    const d = device as { id?: unknown; label?: unknown } | null;
    if (d === null || typeof d !== 'object') return recorder.monitor(undefined);
    if (dictation?.inProgress) return;
    // Si el Hub se cierra sin decir que deje de medir, el micrófono no queda abierto.
    const win = hubWindow();
    win?.removeListener('closed', stopMonitor);
    win?.once('closed', stopMonitor);
    recorder.monitor(typeof d.id === 'string' && d.id ? { id: d.id, label: String(d.label ?? '') } : null);
  });
  ipcMain.handle(IPC.resetSettings, () => {
    // Vuelven los valores por defecto; macOS conserva el inicio de sesión hasta que se aplique.
    const next = defaultPreferences();
    savePreferences(prefsPath, next);
    store.update((s) => ({ ...s, prefs: next }));
    log.info('Settings reset to their defaults');
  });

  // Motores y claves (Hub)
  const toProvider = (v: unknown): CloudProvider => {
    if (!isCloudProvider(v)) throw new Error('Unknown provider');
    return v;
  };
  ipcMain.handle(IPC.saveApiKey, async (_e, provider: unknown, key: unknown) => {
    const p = toProvider(provider);
    const hadKey = store.get().apiKeys[p] === 'saved' || store.get().apiKeys[p] === 'locked';
    const r = await apiKeys.save(p, String(key ?? ''));
    // Con la primera clave de Groq, Groq pasa a hacer todo el trabajo: es mucho
    // más rápido que el equipo. Solo si nadie había elegido otra cosa.
    const prefs = store.get().prefs;
    if (r.ok && p === 'groq' && !hadKey && prefs.transcriptionEngine === 'local' && prefs.formattingProvider === 'ollama') {
      setPreference('transcriptionEngine', 'groq');
      setPreference('formattingProvider', 'groq');
      log.info('First Groq key saved: transcription and cleanup switched to Groq');
    }
    return r;
  });
  ipcMain.handle(IPC.openGroqKeys, () => shell.openExternal('https://console.groq.com/keys'));
  ipcMain.handle(IPC.removeApiKey, async (_e, provider: unknown) => {
    const p = toProvider(provider);
    const r = await apiKeys.remove(p);
    if (r.ok) {
      if (store.get().prefs.transcriptionEngine === p) setPreference('transcriptionEngine', 'local');
      if (store.get().prefs.formattingProvider === p) setPreference('formattingProvider', 'ollama');
    }
    return r;
  });
  ipcMain.handle(IPC.allowApiKey, (_e, provider: unknown) => apiKeys.allow(toProvider(provider)));
  ipcMain.handle(IPC.testApiKey, (_e, provider: unknown) => apiKeys.test(toProvider(provider)));

  app.on('before-quit', () => {
    log.info('Quitting');
    groqUsage.save();
    helper.stop();
    recorder.shutdown();
    bar.shutdown();
    models.stop();
    engine.release('quitting');
    formatting.release('quitting');
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
      bar,
      notices,
      shortcuts,
      paster,
      dictation,
      history,
      dictionary,
      models,
      engine,
      apiKeys,
      formatting,
      showHub,
      describeTrayMenu,
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
