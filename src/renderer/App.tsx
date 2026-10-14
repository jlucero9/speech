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
