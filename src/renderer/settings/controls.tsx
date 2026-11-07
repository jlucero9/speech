// Piezas de los ajustes: sección con su tarjeta, fila de ajuste, interruptor,
// selector y la tecla dibujada como pastilla.

import type { ReactNode } from 'react';
import { ChevronDownIcon } from '../hub/icons';

export function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      {title && <h2 className="settings-section-title">{title}</h2>}
      <div className="settings-card">{children}</div>
    </section>
  );
}

export function SettingRow({
  label,
  description,
  children,
  wide,
}: {
  label: string;
  description?: ReactNode;
  children?: ReactNode;
  /** El control no cabe en la columna de 164 pt (un botón con su estado). */
  wide?: boolean;
}) {
  return (
    <div className="setting-row" data-row={label}>
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {description && <div className="setting-description">{description}</div>}
      </div>
      {children && <div className={wide ? 'setting-control setting-control-wide' : 'setting-control'}>{children}</div>}
    </div>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={`switch ${checked ? 'switch-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string, boolean?][];
  onChange: (v: T) => void;
}) {
  return (
    <span className="settings-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, text, disabled]) => (
          <option key={v} value={v} disabled={disabled}>
            {text}
          </option>
        ))}
      </select>
      <ChevronDownIcon size={16} />
    </span>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'error' | 'muted'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** Botón «Change» y similares: ocupa la columna de control. */
export function RowButton({
  children,
  onClick,
  variant = 'secondary',
  disabled,
}: {
  children: ReactNode;
  onClick: () => unknown;
  variant?: 'secondary' | 'primary';
  disabled?: boolean;
}) {
  return (
    <button type="button" className={`hub-button hub-button-${variant} row-button`} disabled={disabled} onClick={() => void onClick()}>
      {children}
    </button>
  );
}

/** Una tecla de un atajo, como pastilla. */
export function KeyPill({ children }: { children: ReactNode }) {
  return <kbd className="key-pill">{children}</kbd>;
}
