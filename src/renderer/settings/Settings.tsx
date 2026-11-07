import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { HistoryStorage } from '../../shared/preferences';
import { comboLabel, firstBinding } from '../../shared/shortcuts';
import type { SharedState } from '../../shared/state';
import { LOCAL_MODELS, languageLabel } from '../../shared/transcription';
import { KeyIcon, LaptopIcon, ShieldIcon, SlidersIcon } from '../hub/icons';
import { ConfirmDialog, useToast } from '../hub/ui';
import { useSharedState } from '../useSharedState';
import { Badge, KeyPill, RowButton, Section, Select, SettingRow, Switch } from './controls';
import { EnginesPage } from './Engines';
import { LanguagesDialog } from './LanguagesDialog';
import { MicrophoneDialog, microphoneName } from './MicrophoneDialog';
import { ShortcutsDialog } from './ShortcutsDialog';

// Diálogo de ajustes: General (atajos, micrófono, idiomas), System (la app, el
// sonido, permisos y modelo), Engines and Keys (quién transcribe y limpia) y Data and Privacy (contexto e historial). Cada
// cambio se guarda y se aplica al momento; no hay botón de guardar.

export type SettingsSection = 'general' | 'system' | 'engines' | 'data';

const SECTIONS: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <SlidersIcon /> },
  { id: 'system', label: 'System', icon: <LaptopIcon /> },
  { id: 'engines', label: 'Engines and Keys', icon: <KeyIcon /> },
  { id: 'data', label: 'Data and Privacy', icon: <ShieldIcon /> },
];

/** Diálogos que se abren encima de los ajustes. */
type SubDialog = 'shortcuts' | 'microphone' | 'languages' | null;

export function SettingsDialog({
  section,
  onSection,
  onClose,
  onOpenStyle,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  onOpenStyle: () => void;
}) {
  const state = useSharedState();
  const [sub, setSub] = useState<SubDialog>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sub && !document.querySelector('.menu, .confirm')) onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose, sub]);

  // Sin devolver nada: scrollTo devuelve una promesa y React la tomaría por la limpieza.
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [section]);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !sub && onClose()}>
      <div className="modal settings-dialog" role="dialog" aria-modal aria-label="Settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <h2 className="settings-nav-title">Settings</h2>
          <ul>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`settings-nav-item ${section === s.id ? 'settings-nav-item-active' : ''}`}
                  aria-current={section === s.id ? 'page' : undefined}
                  onClick={() => onSection(s.id)}
                >
                  {s.icon}
                  <span>{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="settings-version">Speech v{state?.version ?? ''}</div>
        </nav>
        <div className="settings-content" ref={body}>
          {!state ? (
            <p className="muted">Loading…</p>
          ) : section === 'general' ? (
            <GeneralPage state={state} open={setSub} />
          ) : section === 'system' ? (
            <SystemPage state={state} onOpenStyle={onOpenStyle} />
          ) : section === 'engines' ? (
            <EnginesPage state={state} onOpenStyle={onOpenStyle} />
          ) : (
            <DataPage state={state} />
          )}
        </div>
      </div>
      {state && sub === 'shortcuts' && <ShortcutsDialog state={state} onClose={() => setSub(null)} />}
      {state && sub === 'microphone' && <MicrophoneDialog state={state} onClose={() => setSub(null)} />}
      {state && sub === 'languages' && <LanguagesDialog state={state} onClose={() => setSub(null)} />}
    </div>,
    document.body,
  );
}

function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="settings-title">{children}</h1>;
}

// MARK: General

function GeneralPage({ state, open }: { state: SharedState; open: (d: SubDialog) => void }) {
  const ptt = firstBinding(state.prefs.shortcuts, 'ptt');
  return (
    <>
      <PageTitle>General</PageTitle>
      <Section>
        <SettingRow
          label="Shortcuts"
          description={
            ptt ? (
              <>
                Hold <KeyPill>{comboLabel(ptt.keys, ptt.names)}</KeyPill> and speak.
              </>
            ) : (
              'No shortcut to dictate.'
            )
          }
        >
          <RowButton onClick={() => open('shortcuts')}>Change</RowButton>
        </SettingRow>
        <SettingRow label="Microphone" description={microphoneName(state)}>
          <RowButton onClick={() => open('microphone')}>Change</RowButton>
        </SettingRow>
        <SettingRow label="Dictation Languages" description={languageLabel(state.prefs.dictationLanguage)}>
          <RowButton onClick={() => open('languages')}>Change</RowButton>
        </SettingRow>
      </Section>
    </>
  );
}

// MARK: System

function SystemPage({ state, onOpenStyle }: { state: SharedState; onOpenStyle: () => void }) {
  const p = state.prefs;
  const set = window.speech.setPreference;
  const hidden = p.barHiddenUntil > Date.now();
  const [confirmReset, setConfirmReset] = useState(false);
  const toast = useToast();
  return (
    <>
      <PageTitle>System</PageTitle>
      <Section title="App settings">
        <SettingRow label="Launch app at login">
          <Switch label="Launch app at login" checked={p.launchAtLogin} onChange={(v) => void set('launchAtLogin', v)} />
        </SettingRow>
        <SettingRow label="Show Speech bar at all times" description={hidden ? 'Hidden for one hour' : undefined}>
          <Switch
            label="Show Speech bar at all times"
            checked={p.showBar && !hidden}
            onChange={(v) => {
              if (hidden) void set('barHiddenUntil', 0);
              void set('showBar', v);
            }}
          />
        </SettingRow>
        <SettingRow label="Show app in dock">
          <Switch label="Show app in dock" checked={p.showInDock} onChange={(v) => void set('showInDock', v)} />
        </SettingRow>
      </Section>
      <Section title="Sound">
        <SettingRow label="Dictation and notification sounds">
          <Switch label="Dictation and notification sounds" checked={p.enableSounds} onChange={(v) => void set('enableSounds', v)} />
        </SettingRow>
        <SettingRow label="Mute all audio while dictating">
          <Switch
            label="Mute all audio while dictating"
            checked={p.muteWhileDictating}
            onChange={(v) => void set('muteWhileDictating', v)}
          />
        </SettingRow>
      </Section>
      <Section title="Extras">
        <SettingRow
          label="Smart Formatting"
          description={
            <>
              Smart Formatting is set in the{' '}
              <button type="button" className="inline-link" onClick={onOpenStyle}>
                Auto Cleanup
              </button>{' '}
              tab.
            </>
          }
        />
      </Section>
      <Section title="Permissions">
        <AccessibilityRow state={state} />
        <MicrophonePermissionRow state={state} />
        <InputMonitoringRow state={state} />
        <SecureInputRow state={state} />
        <GlobeKeyRow state={state} />
        <HelperRow state={state} />
      </Section>
      <Section title="Speech model">
        <ModelRow state={state} />
      </Section>
      <Section title="Data">
        <SettingRow label="Reset app" description="Restore every setting to its default. Your history and dictionary are kept.">
          <RowButton onClick={() => setConfirmReset(true)}>Reset settings</RowButton>
        </SettingRow>
      </Section>
      {confirmReset && (
        <ConfirmDialog
          title="Reset all settings?"
          body="Shortcuts, microphone, language and the other settings go back to their defaults. Your history and dictionary are kept."
          confirm="Reset settings"
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            setConfirmReset(false);
            void window.speech.resetSettings().then(() => toast('Settings reset'));
          }}
        />
      )}
    </>
  );
}

function AccessibilityRow({ state }: { state: SharedState }) {
  const a = state.permissions.accessibility;
  return (
    <SettingRow
      label="Accessibility"
      description="Needed to notice your shortcut and paste text into other apps."
      wide={a === 'denied'}
    >
      {a === 'granted' ? (
        <Badge tone="ok">Allowed</Badge>
      ) : a === 'denied' ? (
        <>
          <Badge tone="warn">Not allowed</Badge>
          <button
            type="button"
            className="hub-button hub-button-primary"
            disabled={state.helper.status !== 'ready'}
            onClick={() => void window.speech.requestAccessibility()}
          >
            Allow…
          </button>
          <button type="button" className="hub-button hub-button-secondary" onClick={() => void window.speech.openAccessibilitySettings()}>
            Open System Settings
          </button>
        </>
      ) : (
        <Badge tone="muted">Checking…</Badge>
      )}
    </SettingRow>
  );
}

function MicrophonePermissionRow({ state }: { state: SharedState }) {
  const m = state.permissions.microphone;
  const label: Record<typeof m, string> = {
    granted: 'Allowed',
    denied: 'Not allowed',
    'not-determined': 'Not asked yet',
    restricted: 'Restricted',
    unknown: 'Unknown',
  };
  return (
    <SettingRow
      label="Microphone access"
      description={
        m === 'denied' ? 'Turn on Speech in System Settings › Privacy & Security › Microphone.' : 'Needed to hear what you dictate.'
      }
      wide={m !== 'granted'}
    >
      <Badge tone={m === 'granted' ? 'ok' : m === 'not-determined' ? 'muted' : 'warn'}>{label[m]}</Badge>
      {m === 'not-determined' && (
        <button type="button" className="hub-button hub-button-primary" onClick={() => void window.speech.requestMicrophone()}>
          Allow…
        </button>
      )}
      {m === 'denied' && (
        <button type="button" className="hub-button hub-button-secondary" onClick={() => void window.speech.openMicrophoneSettings()}>
          Open System Settings
        </button>
      )}
    </SettingRow>
  );
}

// Solo aparece si el tap no se puede crear y falta Monitorización de entrada.
function InputMonitoringRow({ state }: { state: SharedState }) {
  const k = state.keyboard;
  if (k.tap !== 'failed' || k.inputMonitoring !== 'denied') return null;
  return (
    <SettingRow label="Input Monitoring" description="Needed to notice your shortcut while you work in other apps." wide>
      <Badge tone="warn">Not allowed</Badge>
      <button type="button" className="hub-button hub-button-primary" onClick={() => void window.speech.requestInputMonitoring()}>
        Allow…
      </button>
      <button type="button" className="hub-button hub-button-secondary" onClick={() => void window.speech.openInputMonitoringSettings()}>
        Open System Settings
      </button>
    </SettingRow>
  );
}

function SecureInputRow({ state }: { state: SharedState }) {
  const owner = state.keyboard.secureInput;
  if (!owner) return null;
  return (
    <SettingRow
      label="Shortcut blocked"
      description={`${owner.appName ?? 'Another app'} has secure input on, usually for a password field. Your shortcut works again when you leave that field or quit the app.`}
    >
      <Badge tone="warn">Secure input</Badge>
    </SettingRow>
  );
}

function GlobeKeyRow({ state }: { state: SharedState }) {
  const usage = state.keyboard.fnUsage;
  const usesFn = state.prefs.shortcuts.some((b) => b.keys.includes(0x3f));
  if (!usesFn || usage === 'nothing' || usage === 'unknown') return null;
  const what = {
    'input-source': 'switches the input source',
    emoji: 'opens Emoji & Symbols',
    dictation: 'starts macOS Dictation when you press it twice',
  }[usage];
  return (
    <SettingRow
      label="Globe key"
      description={`When you press fn, macOS also ${what}. To avoid it, set “Press 🌐 key to” to “Do Nothing” in Keyboard settings.`}
    >
      <RowButton onClick={() => window.speech.openKeyboardSettings()}>Open Settings</RowButton>
    </SettingRow>
  );
}

// Solo si el helper no está en marcha: sin él no hay atajo ni pegado.
function HelperRow({ state }: { state: SharedState }) {
  const h = state.helper;
  if (h.status === 'ready' || h.status === 'starting') return null;
  return (
    <SettingRow label="Speech helper" description={h.lastError ?? 'Handles shortcuts and pasting.'}>
      {h.status === 'failed' ? (
        <RowButton variant="primary" onClick={() => window.speech.retryHelper()}>
          Try again
        </RowButton>
      ) : (
        <Badge tone="warn">Restarting…</Badge>
      )}
    </SettingRow>
  );
}

function ModelRow({ state }: { state: SharedState }) {
  const m = state.transcription.model;
  const spec = LOCAL_MODELS[m.id];
  const now = useNow(m.retryAt !== null);
  const pct = m.totalBytes ? Math.floor((m.receivedBytes / m.totalBytes) * 100) : 0;
  let description: string;
  let control: ReactNode;
  switch (m.status) {
    case 'checking':
      description = `Checking ${spec.label}…`;
      control = <Badge tone="muted">Checking…</Badge>;
      break;
    case 'missing':
      description = `${spec.label} (${mb(spec.sizeBytes)} MB) is needed to transcribe on this Mac.`;
      control = (
        <RowButton variant="primary" onClick={() => window.speech.downloadModel()}>
          Download
        </RowButton>
      );
      break;
    case 'downloading':
      description =
        `Downloading ${spec.label}: ${mb(m.receivedBytes)} of ${mb(m.totalBytes)} MB` +
        (m.bytesPerSecond ? ` · ${(m.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : '') +
        '. It resumes if interrupted.';
      control = (
        <span className="meter meter-wide" role="progressbar" aria-label="Download progress" aria-valuenow={pct}>
          <span className="meter-fill" style={{ width: `${pct}%` }} />
        </span>
      );
      break;
    case 'verifying':
      description = `Checking that ${spec.label} downloaded correctly…`;
      control = <Badge tone="muted">Verifying…</Badge>;
      break;
    case 'ready':
      description = `${spec.label} is on this Mac. Dictation works offline.`;
      control = <Badge tone="ok">Ready</Badge>;
      break;
    case 'failed': {
      const secs = m.retryAt ? Math.max(0, Math.ceil((m.retryAt - now) / 1000)) : 0;
      description = `${m.error ?? 'The download failed.'}${secs ? ` Retrying in ${secs} s.` : ''}`;
      control = (
        <RowButton variant="primary" onClick={() => window.speech.downloadModel()}>
          {m.receivedBytes ? 'Resume' : 'Try again'}
        </RowButton>
      );
      break;
    }
  }
  return (
    <SettingRow label="Speech model" description={description}>
      {control}
    </SettingRow>
  );
}

// MARK: Data and Privacy

const STORAGE_OPTIONS: [HistoryStorage, string][] = [
  ['store', 'Store data locally'],
  ['autodelete', 'Auto-delete local data every 24hrs'],
  ['never', 'Never store data locally'],
];

function DataPage({ state }: { state: SharedState }) {
  const p = state.prefs;
  const [pending, setPending] = useState<HistoryStorage | null>(null);
  const toast = useToast();
  const apply = (v: HistoryStorage) => {
    void window.speech.setPreference('historyStorage', v).then(() => {
      if (v === 'never') toast('All dictations deleted');
      else if (v === 'autodelete') toast('Dictations older than 24 hours deleted');
    });
  };
  return (
    <>
      <PageTitle>Data and Privacy</PageTitle>
      <Section>
        <SettingRow
          label="Context awareness"
          description="Allow Speech to read the text around your cursor in the app you're dictating in, to fit spacing and capitalization. It never leaves this Mac, whichever engine you use."
        >
          <Switch
            label="Context awareness"
            checked={p.contextAwareness}
            onChange={(v) => void window.speech.setPreference('contextAwareness', v)}
          />
        </SettingRow>
        <SettingRow
          label="Local data storage"
          description="Control how your dictation transcripts and their audio are stored on this Mac. Your dictionary is always kept."
        >
          <Select
            label="Local data storage"
            value={p.historyStorage}
            options={STORAGE_OPTIONS}
            onChange={(v) => (v === 'store' ? apply(v) : setPending(v))}
          />
        </SettingRow>
        {!state.data.databaseReady && state.data.error && (
          <SettingRow label="Local data" description={state.data.error}>
            <Badge tone="error">Error</Badge>
          </SettingRow>
        )}
      </Section>
      {pending === 'autodelete' && (
        <ConfirmDialog
          title="Are you sure you want to auto-delete data?"
          body="This will delete transcripts and audio older than 24 hours on this Mac, now and every day from now on."
          confirm="Enable auto-delete"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            apply('autodelete');
          }}
        />
      )}
      {pending === 'never' && (
        <ConfirmDialog
          title="Are you sure you want to never store data?"
          body="This will delete all your transcripts and audio on this Mac, and stop storing new ones."
          confirm="Delete all data"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            apply('never');
          }}
        />
      )}
    </>
  );
}

// MARK: Utilidades

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
