import { useEffect, useState } from 'react';
import type { MicrophoneDevice, SharedState } from '../../shared/state';
import { CloseIcon } from '../hub/icons';

// Micrófono del dictado: el del equipo, «el del sistema» (sigue lo que diga
// macOS) o cualquier otro conectado. El elegido enseña su nivel en vivo; la
// ventana de grabación abre el micrófono solo mientras el diálogo está a la
// vista, y nunca durante un dictado.

/** El micrófono del Mac, si está conectado. */
function builtIn(devices: MicrophoneDevice[]): MicrophoneDevice | null {
  return devices.find((d) => /built-in|macbook.*microphone|imac.*microphone/i.test(d.label)) ?? null;
}

/** Lo que se ve en la fila de ajustes. */
export function microphoneName(state: SharedState): string {
  const p = state.prefs;
  const { devices, systemDefault } = state.microphones;
  if (!p.microphoneId) return `Auto-detect${systemDefault ? ` (${systemDefault})` : ''}`;
  const connected = devices.some((d) => d.id === p.microphoneId || d.label === p.microphoneLabel);
  const name = builtIn(devices)?.label === p.microphoneLabel ? 'Built-in mic (recommended)' : p.microphoneLabel;
  return connected ? name : `${name} (not connected, using Auto-detect)`;
}

interface Choice {
  key: string;
  device: MicrophoneDevice | null;
  title: string;
  subtitle?: string;
}

export function MicrophoneDialog({ state, onClose }: { state: SharedState; onClose: () => void }) {
  const p = state.prefs;
  const { devices, systemDefault } = state.microphones;
  const level = useLevel();

  const mac = builtIn(devices);
  const choices: Choice[] = [];
  if (mac) choices.push({ key: mac.id, device: mac, title: 'Built-in mic (recommended)' });
  choices.push({ key: '', device: null, title: `Auto-detect${systemDefault ? ` (${systemDefault})` : ''}`, subtitle: 'From computer settings' });
  for (const d of devices) if (d !== mac) choices.push({ key: d.id, device: d, title: d.label });
  // El elegido, aunque ahora no esté conectado.
  const selectedChoice =
    choices.find((c) => c.device && (c.device.id === p.microphoneId || c.device.label === p.microphoneLabel)) ??
    (p.microphoneId ? null : choices.find((c) => c.key === ''));
  if (p.microphoneId && !selectedChoice) {
    choices.push({
      key: p.microphoneId,
      device: { id: p.microphoneId, label: p.microphoneLabel },
      title: p.microphoneLabel,
      subtitle: 'Not connected. Dictation uses Auto-detect until it is back.',
    });
  }
  const selectedKey = selectedChoice?.key ?? p.microphoneId;
  const selected = choices.find((c) => c.key === selectedKey);

  // Medir el elegido mientras el diálogo está abierto.
  const monitorKey = selected?.device?.id ?? '';
  const monitorLabel = selected?.device?.label ?? '';
  const dictating = state.dictation.status !== 'idle';
  useEffect(() => {
    if (dictating) return;
    void window.speech.monitorMicrophone({ id: monitorKey, label: monitorLabel });
    return () => void window.speech.monitorMicrophone(null);
  }, [monitorKey, monitorLabel, dictating]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [onClose]);

  const choose = (c: Choice) => {
    void window.speech.setPreference('microphoneId', c.device?.id ?? '');
    void window.speech.setPreference('microphoneLabel', c.device?.label ?? '');
  };

  return (
    <div className="modal-backdrop sub-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sub-dialog microphone-dialog" role="dialog" aria-modal aria-labelledby="microphone-title">
        <header className="sub-dialog-head">
          <div>
            <h2 id="microphone-title" className="modal-title">
              Microphone
            </h2>
            <p className="sub-dialog-subtitle">Used for dictation.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </header>
        <div className="microphone-list" role="radiogroup" aria-label="Microphone">
          {choices.map((c) => {
            const on = c.key === selectedKey;
            return (
              <button
                key={c.key || 'auto'}
                type="button"
                role="radio"
                aria-checked={on}
                className={`microphone-card ${on ? 'microphone-card-selected' : ''}`}
                onClick={() => choose(c)}
              >
                <span className="microphone-text">
                  <span className="microphone-title">{c.title}</span>
                  {c.subtitle && <span className="microphone-subtitle">{c.subtitle}</span>}
                </span>
                {on && <LevelBars level={dictating ? 0 : level} />}
              </button>
            );
          })}
          {devices.length === 0 && <p className="muted">No microphones found.</p>}
        </div>
      </div>
    </div>
  );
}

function useLevel(): number {
  const [level, setLevel] = useState(0);
  useEffect(() => window.speech.onMicrophoneLevel(setLevel), []);
  return level;
}

const BARS = 8;

/** Medidor vertical: se encienden las barras de abajo arriba. */
function LevelBars({ level }: { level: number }) {
  const lit = Math.round(level * BARS);
  return (
    <span className="level-bars" role="meter" aria-label="Input level" aria-valuenow={Math.round(level * 100)} aria-valuemin={0} aria-valuemax={100}>
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} className={BARS - i <= lit ? 'level-bar level-bar-on' : 'level-bar'} />
      ))}
    </span>
  );
}
