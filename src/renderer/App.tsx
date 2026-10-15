import { useEffect, useState, type ReactNode } from 'react';
import type { SharedState } from '../shared/state';
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
    processing: 'Saving…',
  }[d.status];
  const description = d.micSilent
    ? 'No sound is coming from the microphone.'
    : d.status === 'listening'
      ? d.handsFree
        ? 'Press fn again to stop. Esc cancels.'
        : 'Release fn to stop. Esc cancels.'
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
  const tone = last.outcome === 'saved' ? 'ok' : last.outcome === 'failed' ? 'error' : 'muted';
  const badge = { saved: 'Saved', cancelled: 'Cancelled', discarded: 'Discarded', failed: 'Failed' }[last.outcome];
  return (
    <Row
      label="Last dictation"
      description={last.message}
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
