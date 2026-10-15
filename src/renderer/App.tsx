import { useEffect, useState, type ReactNode } from 'react';
import type { SharedState } from '../shared/state';
import {
  DICTATION_LANGUAGES,
  LOCAL_MODELS,
  isLocalModelId,
  type HistoryEntry,
} from '../shared/transcription';
import { useSharedState } from './useSharedState';

// Ventana provisional: muestra el estado de main mientras se construyen los
// pasos del dictado. El Hub real (historial, diccionario, ajustes) llega en
// los pasos 11 a 13.

export function App() {
  const state = useSharedState();
  return (
    <div className="window">
      <div className="titlebar" />
      <main className="content">
        <h1 className="page-title">Speech</h1>
        {state ? <Panels state={state} /> : <p className="muted">Loading…</p>}
      </main>
    </div>
  );
}

function Panels({ state }: { state: SharedState }) {
  return (
    <>
      <Section title="Permissions">
        <AccessibilityRow state={state} />
        <MicrophoneRow state={state} />
        <InputMonitoringRow state={state} />
      </Section>
      <Section title="Dictation">
        <ShortcutRow state={state} />
        <SecureInputRow state={state} />
        <GlobeKeyRow state={state} />
        <DictationRow state={state} />
        <LastDictationRow state={state} />
      </Section>
      <Section title="Transcription">
        <ModelRow state={state} />
        <LanguageRow state={state} />
        <TranscriberRow state={state} />
      </Section>
      <RecentDictations state={state} />
      <Section title="System">
        <HelperRow state={state} />
        <Row
          label="Local data"
          description={
            state.data.databaseReady
              ? `Database ready · schema version ${state.data.schemaVersion}`
              : (state.data.error ?? 'Opening database…')
          }
          status={state.data.databaseReady ? <Badge tone="ok">Ready</Badge> : <Badge tone="error">Error</Badge>}
        />
      </Section>
      <Section title="Sound">
        <Row
          label="Dictation sounds"
          description="Play a sound when dictation starts and stops."
          status={
            <Switch
              label="Dictation sounds"
              checked={state.prefs.enableSounds}
              onChange={(v) => void window.speech.setPreference('enableSounds', v)}
            />
          }
        />
      </Section>
    </>
  );
}

function AccessibilityRow({ state }: { state: SharedState }) {
  const a = state.permissions.accessibility;
  const helperReady = state.helper.status === 'ready';
  return (
    <Row
      label="Accessibility"
      description="Needed to detect your shortcut and paste text into other apps."
      status={
        a === 'granted' ? (
          <Badge tone="ok">Allowed</Badge>
        ) : a === 'denied' ? (
          <>
            <Badge tone="warn">Not allowed</Badge>
            <Button onClick={() => window.speech.requestAccessibility()} disabled={!helperReady}>
              Allow…
            </Button>
            <Button variant="secondary" onClick={() => window.speech.openAccessibilitySettings()}>
              Open System Settings
            </Button>
          </>
        ) : (
          <Badge tone="muted">Checking…</Badge>
        )
      }
    />
  );
}

function MicrophoneRow({ state }: { state: SharedState }) {
  const m = state.permissions.microphone;
  const label: Record<typeof m, string> = {
    granted: 'Allowed',
    denied: 'Not allowed',
    'not-determined': 'Not asked yet',
    restricted: 'Restricted',
    unknown: 'Unknown',
  };
  return (
    <Row
      label="Microphone"
      description={
        m === 'denied'
          ? 'Turn on Speech in System Settings › Privacy & Security › Microphone.'
          : 'Needed to hear what you dictate.'
      }
      status={
        <>
          <Badge tone={m === 'granted' ? 'ok' : m === 'not-determined' ? 'muted' : 'warn'}>{label[m]}</Badge>
          {m === 'not-determined' && <Button onClick={() => window.speech.requestMicrophone()}>Allow…</Button>}
        </>
      }
    />
  );
}

// Solo aparece si el tap no se puede crear y falta Monitorización de entrada.
function InputMonitoringRow({ state }: { state: SharedState }) {
  const k = state.keyboard;
  if (k.tap !== 'failed' || k.inputMonitoring !== 'denied') return null;
  return (
    <Row
      label="Input Monitoring"
      description="Needed to notice your shortcut while you work in other apps."
      status={
        <>
          <Badge tone="warn">Not allowed</Badge>
          <Button onClick={() => window.speech.requestInputMonitoring()}>Allow…</Button>
          <Button variant="secondary" onClick={() => window.speech.openInputMonitoringSettings()}>
            Open System Settings
          </Button>
        </>
      }
    />
  );
}

function ShortcutRow({ state }: { state: SharedState }) {
  const k = state.keyboard;
  const status =
    k.tap === 'active' ? (
      <Badge tone="ok">Active</Badge>
    ) : k.tap === 'no-permission' ? (
      <Badge tone="warn">Needs Accessibility</Badge>
    ) : k.tap === 'failed' ? (
      <Badge tone="error">Not working</Badge>
    ) : (
      <Badge tone="muted">Checking…</Badge>
    );
  const description =
    k.tap === 'failed'
      ? 'macOS refused to let Speech watch the keyboard. Check the permissions above.'
      : 'Hold fn and speak, then release. Press fn twice quickly for hands-free. Esc cancels.';
  return <Row label="Shortcut" description={description} status={status} />;
}

function SecureInputRow({ state }: { state: SharedState }) {
  const owner = state.keyboard.secureInput;
  if (!owner) return null;
  return (
    <Row
      label="Shortcut blocked"
      description={`${owner.appName ?? 'Another app'} has secure input on, usually for a password field. Your shortcut works again when you leave that field or quit the app.`}
      status={<Badge tone="warn">Secure input</Badge>}
    />
  );
}

function GlobeKeyRow({ state }: { state: SharedState }) {
  const usage = state.keyboard.fnUsage;
  if (usage === 'nothing' || usage === 'unknown') return null;
  const what = {
    'input-source': 'switches the input source',
    emoji: 'opens Emoji & Symbols',
    dictation: 'starts macOS Dictation when you press it twice',
  }[usage];
  return (
    <Row
      label="Globe key"
      description={`When you press fn, macOS also ${what}. To avoid it, set “Press 🌐 key to” to “Do Nothing” in Keyboard settings.`}
      status={
        <Button variant="secondary" onClick={() => window.speech.openKeyboardSettings()}>
          Open Keyboard Settings
        </Button>
      }
    />
  );
}

function DictationRow({ state }: { state: SharedState }) {
  const d = state.dictation;
  const label = {
    idle: 'Ready',
    initializing: 'Starting…',
    listening: d.handsFree ? 'Listening · hands-free' : 'Listening',
    stopping: 'Finishing…',
    processing: 'Transcribing…',
  }[d.status];
  const description = d.micSilent
    ? 'No sound is coming from the microphone.'
    : d.status === 'listening'
      ? d.handsFree
        ? 'Press fn again to stop. Esc cancels.'
        : 'Release fn to stop. Esc cancels.'
      : d.status === 'processing'
        ? 'Esc cancels.'
        : 'Current state of dictation.';
  return (
    <Row
      label="Status"
      description={description}
      status={
        <>
          {d.status === 'listening' && <LevelMeter level={d.level} />}
          <Badge tone={d.status === 'idle' ? 'muted' : d.micSilent ? 'warn' : 'ok'}>{label}</Badge>
        </>
      }
    />
  );
}

function LastDictationRow({ state }: { state: SharedState }) {
  const last = state.dictation.last;
  if (!last) return null;
  const tone = last.outcome === 'done' ? 'ok' : last.outcome === 'failed' ? 'error' : 'muted';
  const badge = { done: 'Done', cancelled: 'Cancelled', discarded: 'Discarded', failed: 'Failed' }[last.outcome];
  return (
    <Row
      label="Last dictation"
      description={last.text ? `“${last.text}” · ${last.message}` : last.message}
      status={
        <>
          <Badge tone={tone}>{badge}</Badge>
          {last.file && (
            <Button variant="secondary" onClick={() => window.speech.revealRecording()}>
              Show in Finder
            </Button>
          )}
        </>
      }
    />
  );
}

function ModelRow({ state }: { state: SharedState }) {
  const m = state.transcription.model;
  const spec = LOCAL_MODELS[m.id];
  const now = useNow(m.retryAt !== null);
  const pct = m.totalBytes ? Math.floor((m.receivedBytes / m.totalBytes) * 100) : 0;
  const size = `${mb(spec.sizeBytes)} MB`;
  let description: string;
  let status: ReactNode;
  switch (m.status) {
    case 'checking':
      description = `Checking ${spec.label}…`;
      status = <Badge tone="muted">Checking…</Badge>;
      break;
    case 'missing':
      description = `${spec.label} (${size}) is needed to transcribe on this Mac.`;
      status = <Button onClick={() => window.speech.downloadModel()}>Download</Button>;
      break;
    case 'downloading':
      description =
        `Downloading ${spec.label}: ${mb(m.receivedBytes)} of ${mb(m.totalBytes)} MB` +
        (m.bytesPerSecond ? ` · ${(m.bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : '') +
        '. You can keep using your Mac; it resumes if interrupted.';
      status = (
        <>
          <Progress value={pct / 100} label="Download progress" />
          <Badge tone="muted">{pct}%</Badge>
        </>
      );
      break;
    case 'verifying':
      description = `Checking that ${spec.label} downloaded correctly…`;
      status = <Badge tone="muted">Verifying…</Badge>;
      break;
    case 'ready':
      description = `${spec.label} is on this Mac. Dictation works offline.`;
      status = <Badge tone="ok">Ready</Badge>;
      break;
    case 'failed': {
      const secs = m.retryAt ? Math.max(0, Math.ceil((m.retryAt - now) / 1000)) : 0;
      description = `${m.error ?? 'The download failed.'}${secs ? ` Retrying in ${secs} s.` : ''}`;
      status = (
        <>
          <Badge tone="error">Not downloaded</Badge>
          <Button onClick={() => window.speech.downloadModel()}>{m.receivedBytes ? 'Resume' : 'Try again'}</Button>
        </>
      );
      break;
    }
  }
  return <Row label="Speech model" description={description} status={status} />;
}

function LanguageRow({ state }: { state: SharedState }) {
  const current = state.prefs.dictationLanguage;
  return (
    <Row
      label="Language"
      description="The language you dictate in."
      status={
        <Select
          label="Language"
          value={current}
          options={Object.entries(DICTATION_LANGUAGES)}
          onChange={(v) => void window.speech.setPreference('dictationLanguage', v)}
        />
      }
    />
  );
}

function TranscriberRow({ state }: { state: SharedState }) {
  const t = state.transcription.transcriber;
  const now = useNow(t.unloadAt !== null);
  const memory = t.memoryBytes ? ` · ${mb(t.memoryBytes)} MB` : '';
  const mins = t.unloadAt ? Math.max(1, Math.ceil((t.unloadAt - now) / 60_000)) : 0;
  const [badge, tone, description]: [string, 'ok' | 'warn' | 'error' | 'muted', string] = (() => {
    switch (t.status) {
      case 'stopped':
        return ['Not loaded', 'muted', 'The model loads when you start dictating and is freed after a few idle minutes.'];
      case 'loading':
        return ['Loading…', 'muted', 'Loading the model.'];
      case 'ready':
        return ['Loaded', 'ok', `In memory${memory}${mins ? ` · freed in ${mins} min if unused` : ''}.`];
      case 'busy':
        return ['Transcribing…', 'ok', `In memory${memory}.`];
      case 'failed':
        return ['Stopped', 'warn', `${t.error ?? 'The transcriber stopped.'} It starts again with the next dictation.`];
    }
  })();
  return <Row label="Transcriber" description={description} status={<Badge tone={tone}>{badge}</Badge>} />;
}

function RecentDictations({ state }: { state: SharedState }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const last = state.dictation.last;
  // Cada dictado que termina cambia `last`: se vuelve a leer la lista.
  const key = last ? `${last.id}:${last.outcome}:${last.file ?? ''}` : '';
  useEffect(() => {
    let alive = true;
    void window.speech.listHistory(10).then((rows) => alive && setEntries(rows));
    return () => {
      alive = false;
    };
  }, [key]);
  if (!entries) return null;
  return (
    <Section title="Recent dictations">
      {entries.length === 0 ? (
        <Row label="Nothing yet" description="Hold fn, speak and release. Your dictations appear here." status={null} />
      ) : (
        entries.map((e) => <HistoryRow key={e.id} entry={e} />)
      )}
    </Section>
  );
}

function HistoryRow({ entry: e }: { entry: HistoryEntry }) {
  const when = new Date(e.createdAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const facts = [
    when,
    e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)} s` : null,
    e.transcriptionMs != null ? `transcribed in ${(e.transcriptionMs / 1000).toFixed(1)} s` : null,
    e.model && isLocalModelId(e.model) ? LOCAL_MODELS[e.model].label : e.model,
    e.language,
  ].filter(Boolean);
  const tone = e.status === 'done' ? 'ok' : e.status === 'failed' ? 'error' : 'muted';
  const label = { recording: 'Recording', processing: 'Transcribing', done: 'Done', cancelled: 'Cancelled', failed: 'Failed' }[
    e.status
  ];
  const text = e.text ? e.text : e.status === 'done' ? 'No speech detected.' : (e.error ?? '');
  return (
    <div className="row history-row" data-row="history">
      <div className="row-text">
        <div className={`history-text ${e.text ? '' : 'muted'}`}>{text}</div>
        <div className="row-description">{facts.join(' · ')}</div>
      </div>
      <div className="row-status">
        <Badge tone={tone}>{label}</Badge>
        {e.audioPath && (
          <Button variant="secondary" onClick={() => window.speech.revealRecording(e.id)}>
            Audio
          </Button>
        )}
      </div>
    </div>
  );
}

function Progress({ value, label }: { value: number; label: string }) {
  return (
    <span className="meter meter-wide" role="progressbar" aria-label={label} aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span className="meter-fill" style={{ width: `${Math.round(value * 100)}%` }} />
    </span>
  );
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function LevelMeter({ level }: { level: number }) {
  return (
    <span className="meter" role="meter" aria-label="Input level" aria-valuenow={level} aria-valuemin={0} aria-valuemax={1}>
      <span className="meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
    </span>
  );
}

function HelperRow({ state }: { state: SharedState }) {
  const h = state.helper;
  const now = useNow(h.status === 'restarting');
  const status = (() => {
    switch (h.status) {
      case 'ready':
        return <Badge tone="ok">Running</Badge>;
      case 'starting':
        return <Badge tone="muted">Starting…</Badge>;
      case 'restarting': {
        const secs = h.nextAttemptAt ? Math.max(0, Math.ceil((h.nextAttemptAt - now) / 1000)) : 0;
        return <Badge tone="warn">{secs > 0 ? `Restarting in ${secs}s` : 'Restarting…'}</Badge>;
      }
      case 'failed':
        return (
          <>
            <Badge tone="error">Not running</Badge>
            <Button onClick={() => window.speech.retryHelper()}>Try again</Button>
          </>
        );
      case 'stopped':
        return <Badge tone="muted">Stopped</Badge>;
    }
  })();
  const detail =
    h.status === 'ready'
      ? `Process ${h.pid}${h.restarts ? ` · restarted ${h.restarts}×` : ''}`
      : (h.lastError ?? 'Handles shortcuts, pasting and permissions.');
  return <Row label="Speech helper" description={detail} status={status} />;
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2 className="section-title">{title}</h2>
      <div className="card">{children}</div>
    </section>
  );
}

function Row({ label, description, status }: { label: string; description: string; status: ReactNode }) {
  return (
    <div className="row" data-row={label}>
      <div className="row-text">
        <div className="row-label">{label}</div>
        <div className="row-description">{description}</div>
      </div>
      <div className="row-status">{status}</div>
    </div>
  );
}

function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'error' | 'muted'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
}: {
  children: ReactNode;
  onClick: () => unknown;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`button button-${variant}`} onClick={() => void onClick()} disabled={disabled}>
      {children}
    </button>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
}) {
  return (
    <select className="select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      className={`switch ${checked ? 'switch-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}
