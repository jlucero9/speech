import { useEffect, useState, type ReactNode } from 'react';
import type { BarEdge } from '../../shared/bar';
import { FORMATTING_PROVIDERS, type FormattingProvider } from '../../shared/formatting';
import type { PasteResult, SharedState } from '../../shared/state';
import { DICTATION_LANGUAGES, LOCAL_MODELS } from '../../shared/transcription';

// Ajustes provisionales: el estado de main y los pocos ajustes que ya hay,
// tal como estaban antes del Hub. Viven en el diálogo de ajustes hasta que
// llegue la pantalla de ajustes definitiva.

export function ProvisionalSettings({ state }: { state: SharedState }) {
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
      <Section title="Formatting">
        <SmartFormattingRow state={state} />
        <FormattingProviderRow state={state} />
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
      <Section title="Bar">
        <BarRows state={state} />
      </Section>
      <Section title="Sound">
        <Row
          label="Dictation and notification sounds"
          description="Play a sound when dictation starts and stops, and when the bar shows a notice."
          status={
            <Switch
              label="Dictation and notification sounds"
              checked={state.prefs.enableSounds}
              onChange={(v) => void window.speech.setPreference('enableSounds', v)}
            />
          }
        />
      </Section>
    </>
  );
}

function BarRows({ state }: { state: SharedState }) {
  const p = state.prefs;
  const hiddenUntil = p.barHiddenUntil > Date.now() ? new Date(p.barHiddenUntil) : null;
  return (
    <>
      <Row
        label="Show the bar at all times"
        description={
          hiddenUntil
            ? `Hidden until ${hiddenUntil.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. It still appears while you dictate.`
            : 'When off, the bar only appears while you dictate or have a notice.'
        }
        status={
          <>
            {hiddenUntil && (
              <Button variant="secondary" onClick={() => window.speech.setPreference('barHiddenUntil', 0)}>
                Show now
              </Button>
            )}
            <Switch
              label="Show the bar at all times"
              checked={p.showBar}
              onChange={(v) => void window.speech.setPreference('showBar', v)}
            />
          </>
        }
      />
      <Row
        label="Bar position"
        description="You can also drag the bar to the bottom, left or right edge of the screen."
        status={
          <Select
            label="Bar position"
            value={p.barEdge}
            options={[
              ['bottom', 'Bottom'],
              ['left', 'Left'],
              ['right', 'Right'],
            ]}
            onChange={(v) => void window.speech.setPreference('barEdge', v as BarEdge)}
          />
        }
      />
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
      : 'Hold fn and speak, then release. For hands-free, double-tap fn or press fn + Space; tap fn again to stop. Esc cancels.';
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
  const paste = last.paste ? pasteSummary(last.paste.result, last.paste.appName, last.paste.ms) : null;
  const format = last.format ? formatSummary(last.format.result, last.format.ms) : null;
  return (
    <Row
      label="Last dictation"
      description={[last.text?.trim() ? `“${last.text.trim()}”` : null, last.message, format, paste].filter(Boolean).join(' · ')}
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

function SmartFormattingRow({ state }: { state: SharedState }) {
  return (
    <Row
      label="Smart Formatting"
      description="Removes filler words and false starts, and fixes punctuation. Off: the transcript is pasted as is."
      status={
        <Switch
          label="Smart Formatting"
          checked={state.prefs.smartFormatting}
          onChange={(v) => void window.speech.setPreference('smartFormatting', v)}
        />
      }
    />
  );
}

const PROVIDER_LABELS: Record<FormattingProvider, string> = {
  ollama: 'On this Mac (Ollama)',
  groq: 'Groq (your key)',
  gemini: 'Gemini (your key)',
};

function FormattingProviderRow({ state }: { state: SharedState }) {
  const f = state.formatting;
  if (f.status === 'off') return null;
  const [badge, tone]: [string, 'ok' | 'warn' | 'error' | 'muted'] = {
    off: ['Off', 'muted'] as [string, 'muted'],
    checking: ['Checking…', 'muted'] as [string, 'muted'],
    ready: ['Ready', 'ok'] as [string, 'ok'],
    no_server: ['Not running', 'warn'] as [string, 'warn'],
    no_model: ['Model missing', 'warn'] as [string, 'warn'],
    no_key: ['No key', 'warn'] as [string, 'warn'],
  }[f.status];
  const cloud = f.provider !== 'ollama' ? ' Your dictation, the app name and your dictionary words are sent to this service.' : '';
  const description = `Model ${f.model}.${cloud}${f.detail ? ` ${f.detail}` : ''}${
    f.status !== 'ready' && f.status !== 'checking' ? ' Until then, dictations are pasted unformatted.' : ''
  }`;
  return (
    <Row
      label="Formatting with"
      description={description}
      status={
        <>
          <Badge tone={tone}>{badge}</Badge>
          <Select
            label="Formatting with"
            value={f.provider}
            options={FORMATTING_PROVIDERS.map((p) => [p, PROVIDER_LABELS[p]])}
            onChange={(v) => void window.speech.setPreference('formattingProvider', v as FormattingProvider)}
          />
        </>
      }
    />
  );
}

/** Cómo acabó el formateo, en pocas palabras; null si no hay nada que decir. */
function formatSummary(result: string | null, ms: number | null): string | null {
  if (!result) return null;
  if (result === 'formatted') return ms != null ? `formatted in ${(ms / 1000).toFixed(1)} s` : 'formatted';
  if (result === 'off') return null;
  const why: Record<string, string> = {
    raw_timeout: 'took too long',
    raw_not_ready: 'formatter not available',
    raw_rejected: 'the result changed the meaning',
    raw_auth: 'invalid key',
    raw_quota: 'usage limit reached',
    raw_network: 'no connection',
    raw_failed: 'formatter error',
  };
  return `pasted unformatted (${why[result] ?? result.replace(/^raw_/, '')})`;
}

function pasteSummary(result: PasteResult, appName: string | null, ms: number | null): string | null {
  const app = appName ?? 'the app';
  const time = ms != null ? ` ${(ms / 1000).toFixed(1)} s after release` : '';
  switch (result) {
    case 'pasted':
    case 'pasted_unverified':
      return `pasted into ${app}${time}`;
    case 'pending':
      return `pasting into ${app}…`;
    case 'empty':
      return null;
    case 'not_requested':
      return `not pasted (${app} didn't take it); left on the clipboard`;
    case 'unconfirmed':
      return 'paste not confirmed; left on the clipboard';
    case 'target_gone':
      return `not pasted (${app} closed); left on the clipboard`;
    case 'focus_failed':
      return `not pasted (couldn't switch back to ${app}); left on the clipboard`;
    case 'failed':
      return 'not pasted; left on the clipboard';
  }
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
