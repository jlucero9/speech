// Piezas comunes del Hub: botón de icono con su ayuda, menú desplegable,
// diálogo de confirmación y avisos emergentes.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

// MARK: Avisos emergentes

interface Toast {
  id: number;
  text: string;
}

const ToastContext = createContext<(text: string) => void>(() => {});

export function useToast(): (text: string) => void {
  return useContext(ToastContext);
}

const TOAST_MS = 3_000;

/** Uno a la vez, abajo a la derecha; el nuevo sustituye al anterior. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const next = useRef(1);
  const show = useCallback((text: string) => setToast({ id: next.current++, text }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast &&
        createPortal(
          <div className="toast" role="status" key={toast.id}>
            {toast.text}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

// MARK: Botón de icono

export function IconButton({
  label,
  onClick,
  children,
  active,
  disabled,
  buttonRef,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`icon-button ${active ? 'icon-button-active' : ''}`}
      aria-label={label}
      data-tooltip={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// MARK: Menú

export interface MenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Motivo por el que está deshabilitado, como ayuda. */
  hint?: string;
}

/**
 * Menú bajo un botón, alineado a su borde derecho. Si no cabe debajo, se abre
 * encima. Se cierra con un clic fuera, Esc o al desplazar la página.
 */
export function Menu({ anchor, items, onClose }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const a = anchor.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    const below = a.bottom + 4;
    const top = below + m.height <= window.innerHeight - 8 ? below : Math.max(8, a.top - 4 - m.height);
    const left = Math.max(8, Math.min(a.right - m.width, window.innerWidth - 8 - m.width));
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const scroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('blur', onClose);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, []);

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length];
        next?.focus();
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`menu-item ${item.destructive ? 'menu-item-destructive' : ''}`}
          disabled={item.disabled}
          title={item.disabled ? item.hint : undefined}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

// MARK: Diálogo de confirmación

export function ConfirmDialog({
  title,
  body,
  confirm,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onCancel]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal confirm" role="alertdialog" aria-modal aria-labelledby="confirm-title">
        <div className="confirm-text">
          <h2 id="confirm-title" className="modal-title">
            {title}
          </h2>
          <p className="confirm-body">{body}</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="hub-button hub-button-outline" onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} type="button" className="hub-button hub-button-destructive" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
