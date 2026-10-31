import { useCallback, useEffect, useState } from 'react';
import {
  anySide,
  DEFAULT_SHORTCUTS,
  MAX_PER_ACTION,
  REQUIRED,
  checkShortcut,
  keyLabel,
  recordedKeys,
  type ShortcutAction,
  type ShortcutBinding,
} from '../../shared/shortcuts';
import type { SharedState, ShortcutRecording } from '../../shared/state';
import { CloseIcon, PencilIcon, PlusIcon, TrashIcon } from '../hub/icons';
import { useToast } from '../hub/ui';
import { KeyPill } from './controls';

// Editor de atajos. Grabar una combinación: el helper deja de disparar los
// atajos y manda todas las teclas hasta que se sueltan; lo pulsado a la vez es
// la combinación. Se valida (sin repetir, con modificador, no las del sistema)
// y se guarda en el acto.

const ACTIONS: { action: ShortcutAction; title: string; description: string }[] = [
  { action: 'ptt', title: 'Push to talk', description: 'Hold to say something short' },
  { action: 'hands_free', title: 'Hands-free mode', description: 'Dictate hands-free by pressing this hotkey to start and stop' },
  { action: 'paste_last', title: 'Paste last transcript', description: 'Paste the last thing you dictated' },
  { action: 'copy_last', title: 'Copy last transcript', description: 'Copy the last thing you dictated' },
  { action: 'dismiss', title: 'Cancel', description: 'Dismiss dictation and notifications' },
];

/** Qué se está grabando: sustituir el atajo `index` de la lista, o añadir uno a `action`. */
type Target = { action: ShortcutAction; index: number | null };

export function ShortcutsDialog({ state, onClose }: { state: SharedState; onClose: () => void }) {
  const list = state.prefs.shortcuts;
  const [target, setTarget] = useState<Target | null>(null);
  const [held, setHeld] = useState<ShortcutRecording | null>(null);
  const [message, setMessage] = useState<{ action: ShortcutAction; text: string; tone: 'error' | 'warning' } | null>(null);
  const toast = useToast();

  const stop = useCallback(() => {
    setTarget(null);
    setHeld(null);
    void window.speech.recordShortcut(false);
  }, []);

  const save = useCallback((next: ShortcutBinding[]) => window.speech.setPreference('shortcuts', next), []);

  const start = (t: Target) => {
    setTarget(t);
    setHeld(null);
    setMessage(null);
    void window.speech.recordShortcut(true);
  };

  // Teclas que llegan mientras se graba.
  useEffect(() => {
    if (!target) return;
    return window.speech.onShortcutRecording((r) => {
      setHeld(r);
      if (!r.done) return;
      const keys = recordedKeys(r.done);
      const names = Object.fromEntries(Object.entries(r.names).filter(([k]) => keys.includes(Number(k))));
      const check = checkShortcut(target.action, keys, list, target.index, names);
      if (!check.ok) {
        // Sigue grabando: se puede probar otra combinación.
        setMessage({ action: target.action, text: check.error, tone: 'error' });
        return;
      }
      const binding: ShortcutBinding = { action: target.action, keys, ...(Object.keys(names).length ? { names } : {}) };
      const next = [...list];
      if (target.index === null) next.push(binding);
      else next[target.index] = binding;
      stop();
      setMessage(check.warning ? { action: target.action, text: check.warning, tone: 'warning' } : null);
      void save(next).then(() => toast('Shortcut saved'));
    });
  }, [target, list, save, stop, toast]);

  // Fuera del Hub, main ya paró la grabación.
  useEffect(() => {
    if (!target) return;
    window.addEventListener('blur', stop);
    return () => window.removeEventListener('blur', stop);
  }, [target, stop]);

  // Al cerrar el diálogo, que no quede grabando.
  useEffect(() => () => void window.speech.recordShortcut(false), []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.confirm')) return;
      e.stopPropagation();
      if (target) stop();
      else onClose();
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [onClose, stop, target]);

  const remove = (index: number) => {
    const b = list[index];
    if (REQUIRED.has(b.action) && list.filter((x) => x.action === b.action).length === 1) return;
    setMessage(null);
    void save(list.filter((_, i) => i !== index)).then(() => toast('Shortcut removed'));
  };

  const ptt = list.find((b) => b.action === 'ptt');

  return (
    <div className="modal-backdrop sub-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sub-dialog shortcuts-dialog" role="dialog" aria-modal aria-labelledby="shortcuts-title">
        <header className="sub-dialog-head">
          <div>
            <h2 id="shortcuts-title" className="modal-title">
              Shortcuts
            </h2>
            <p className="sub-dialog-subtitle">Choose your preferred shortcuts for using Speech.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </header>
        <div className="shortcuts-list">
          {ACTIONS.map(({ action, title, description }) => {
            const entries = list.map((b, index) => ({ b, index })).filter((e) => e.b.action === action);
            const adding = target?.action === action && target.index === null;
            const canAdd = action !== 'dismiss' && entries.length < MAX_PER_ACTION && !adding;
            // Como manos libres siempre tiene el doble toque, su atajo se puede quitar; los demás, si hay otro.
            const removable = (n: number) => n > 1 || action === 'hands_free';
            const msg = message?.action === action ? message : null;
            return (
              <div key={action} className="shortcut-card">
                <div className="shortcut-text">
                  <div className="shortcut-title">{title}</div>
                  <div className="shortcut-description">{description}</div>
                  {msg && <div className={`shortcut-message shortcut-message-${msg.tone}`}>{msg.text}</div>}
                </div>
                <div className="shortcut-fields">
                  {action === 'hands_free' && ptt && (
                    <div className="shortcut-row">
                      <div className="shortcut-field shortcut-field-fixed">
                        <span className="shortcut-hint">Double tap</span>
                        {ptt.keys.map((k) => (
                          <KeyPill key={k}>{keyLabel(k, ptt.names)}</KeyPill>
                        ))}
                      </div>
                    </div>
                  )}
                  {entries.map(({ b, index }, i) => (
                    <div className="shortcut-row" key={index}>
                      <ShortcutField
                        binding={b}
                        recording={target?.index === index ? held : undefined}
                        onEdit={() => (target?.index === index ? stop() : start({ action, index }))}
                        onRemove={removable(entries.length) ? () => remove(index) : undefined}
                      />
                      {i === 0 && (canAdd || adding) ? (
                        <AddButton onClick={() => (adding ? stop() : start({ action, index: null }))} />
                      ) : (
                        <span className="shortcut-add-spacer" />
                      )}
                    </div>
                  ))}
                  {adding && (
                    <div className="shortcut-row">
                      <ShortcutField binding={null} recording={held} onEdit={stop} />
                      <span className="shortcut-add-spacer" />
                    </div>
                  )}
                  {entries.length === 0 && !adding && (
                    <div className="shortcut-row">
                      <ShortcutField binding={null} onEdit={() => start({ action, index: null })} />
                      <span className="shortcut-add-spacer" />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <footer className="sub-dialog-foot">
          <button
            type="button"
            className="hub-button hub-button-secondary"
            onClick={() => {
              stop();
              setMessage(null);
              void save(DEFAULT_SHORTCUTS).then(() => toast('Reset to default'));
            }}
          >
            Reset to default
          </button>
          <button type="button" className="hub-button hub-button-primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

function ShortcutField({
  binding,
  recording,
  onEdit,
  onRemove,
}: {
  binding: ShortcutBinding | null;
  /** undefined: no se graba este; null: se graba y aún no hay teclas. */
  recording?: ShortcutRecording | null;
  onEdit: () => void;
  onRemove?: () => void;
}) {
  const isRecording = recording !== undefined;
  // Mientras se mantienen, sin lado: así quedan en cuanto lleva una tecla normal.
  const live = recording && recording.held.length ? recordedKeys(recording.held).map((k) => anySide(k) ?? k) : null;
  return (
    <div
      className={`shortcut-field ${isRecording ? 'shortcut-field-recording' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={isRecording ? 'Press the new shortcut' : binding ? 'Edit shortcut' : 'Click to add a shortcut'}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      <span className="shortcut-keys">
        {isRecording ? (
          live ? (
            live.map((k) => <KeyPill key={k}>{keyLabel(k, recording?.names)}</KeyPill>)
          ) : (
            <span className="shortcut-hint">Enter new hotkey</span>
          )
        ) : binding ? (
          binding.keys.map((k) => <KeyPill key={k}>{keyLabel(k, binding.names)}</KeyPill>)
        ) : (
          <span className="shortcut-hint">Click to add a shortcut</span>
        )}
      </span>
      {isRecording ? (
        <span className="shortcut-cancel">Cancel</span>
      ) : (
        <span className="shortcut-tools">
          <span className="shortcut-tool" aria-hidden>
            <PencilIcon size={18} />
          </span>
          {onRemove && (
            <button
              type="button"
              className="shortcut-tool"
              aria-label="Remove shortcut"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              <TrashIcon size={18} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="shortcut-add" aria-label="Add another" title="Add another" onClick={onClick}>
      <PlusIcon size={22} strokeWidth={1.5} />
    </button>
  );
}
