import type { Preferences } from './preferences';
import type { MicrophoneDevice, MicrophonesState } from './state';

// Las opciones de micrófono del dictado: el del Mac, «el del sistema» (sigue
// lo que diga macOS) o cualquier otro conectado. Las usan el diálogo de
// ajustes y el menú de la barra.

/** El micrófono del Mac, si está conectado. */
export function builtInMicrophone(devices: MicrophoneDevice[]): MicrophoneDevice | null {
  return devices.find((d) => /built-in|macbook.*microphone|imac.*microphone/i.test(d.label)) ?? null;
}

/**
 * Nombre corto de un micrófono, sin lo que repite macOS: «MacBook Air
 * Microphone (Built-in)» → «MacBook Air», «Jose’s iPhone Microphone» →
 * «Jose’s iPhone».
 */
export function microphoneName(label: string): string {
  const short = label
    .replace(/\s*\(built-in\)\s*$/i, '')
    .replace(/\s+microphone$/i, '')
    .trim();
  return short || label;
}

export interface MicrophoneChoice {
  /** El id del micrófono; '' para «el del sistema». */
  key: string;
  device: MicrophoneDevice | null;
  title: string;
  subtitle?: string;
}

type Prefs = Pick<Preferences, 'microphoneId' | 'microphoneLabel'>;

/** Las opciones en orden y cuál está elegida (el elegido sale aunque no esté conectado). */
export function microphoneChoices(p: Prefs, m: Pick<MicrophonesState, 'devices' | 'systemDefault'>): {
  choices: MicrophoneChoice[];
  selectedKey: string;
} {
  const { devices, systemDefault } = m;
  const mac = builtInMicrophone(devices);
  const choices: MicrophoneChoice[] = [];
  if (mac) choices.push({ key: mac.id, device: mac, title: 'Built-in mic (recommended)' });
  choices.push({ key: '', device: null, title: `Auto-detect${systemDefault ? ` (${microphoneName(systemDefault)})` : ''}`, subtitle: 'From computer settings' });
  for (const d of devices) if (d !== mac) choices.push({ key: d.id, device: d, title: microphoneName(d.label) });
  const selected =
    choices.find((c) => c.device && (c.device.id === p.microphoneId || c.device.label === p.microphoneLabel)) ??
    (p.microphoneId ? null : choices.find((c) => c.key === ''));
  if (p.microphoneId && !selected) {
    choices.push({
      key: p.microphoneId,
      device: { id: p.microphoneId, label: p.microphoneLabel },
      title: microphoneName(p.microphoneLabel),
      subtitle: 'Not connected. Dictation uses Auto-detect until it is back.',
    });
  }
  return { choices, selectedKey: selected?.key ?? p.microphoneId };
}

/** El micrófono que usaría ahora un dictado: el elegido si está conectado; si no, el del sistema. */
export function microphoneInUse(p: Prefs, m: MicrophonesState): string | null {
  if (p.microphoneId) {
    const d = m.devices.find((x) => x.id === p.microphoneId || x.label === p.microphoneLabel);
    if (d) return d.label;
  }
  return m.systemDefault ?? m.lastUsed;
}
