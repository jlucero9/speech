import { StrictMode, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { BarEdge, Notice } from '../../shared/bar';
import type { BarApi } from '../../shared/ipc';
import type { SharedState } from '../../shared/state';
import { AlertIcon, CheckIcon, CloseIcon, ErrorIcon, InfoIcon, MicIcon } from './icons';
import { playSound } from './sounds';
import './bar.css';
import { compactLabel, firstBinding, type ShortcutBinding } from '../../shared/shortcuts';

// La barra flotante. Pinta el estado del dictado que llega de main y le
// devuelve los clics; no decide nada por su cuenta.
//
// La ventana deja pasar el ratón salvo cuando el cursor está sobre una zona
// marcada con data-hot: entonces se pide a main que la ventana reciba clics.

declare global {
  interface Window {
    bar: BarApi;
  }
}

const api = window.bar;

/** Píxeles que hay que mover el ratón con el botón pulsado para que cuente como arrastre. */
const DRAG_THRESHOLD = 4;
/** Número de barras de la onda. */
const WAVE_BARS = 10;
/** Altura relativa de cada barra: más altas en el centro. */
const WAVE_PROFILE = [0.5, 0.75, 0.95, 1.1, 1.2, 1.25, 1.1, 0.95, 0.75, 0.5];

type PillState = 'resting' | 'ready' | 'ptt' | 'popo' | 'processing' | 'error';

function useSharedState(): SharedState | null {
  const [state, setState] = useState<SharedState | null>(null);
  useEffect(() => {
    let alive = true;
    const off = api.onState((s) => alive && setState(s));
    void api.getState().then((s) => alive && setState((prev) => prev ?? s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}

/**
 * El cursor está sobre una zona activa: la ventana recibe clics mientras dure.
 * También dice si está sobre la píldora; se mira en cada movimiento porque,
 * tras mover la ventana (al arrastrarla), los eventos de entrar y salir no
 * siempre llegan.
 */
function useHotTracking(): { hot: boolean; overPill: boolean } {
  const [hot, setHot] = useState(false);
  const [overPill, setOverPill] = useState(false);
  useEffect(() => {
    let current = false;
    const set = (on: boolean): void => {
      if (on === current) return;
      current = on;
      setHot(on);
      api.setInteractive(on);
    };
    const onMove = (e: MouseEvent): void => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      set(!!el?.closest('[data-hot]'));
      setOverPill(!!el?.closest('.pill'));
    };
    // Durante un arrastre el puntero está capturado: no se suelta la ventana.
    const onLeave = (e: MouseEvent): void => {
      if (e.buttons !== 0) return;
      set(false);
      setOverPill(false);
    };
    document.addEventListener('mousemove', onMove);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, []);
  return { hot, overPill };
}

function App() {
  const state = useSharedState();
  const { hot, overPill: pillHover } = useHotTracking();

  useEffect(() => api.onSound((s) => playSound(s, s === 'start' || s === 'stop' || s === 'lock' ? 1 : 0.5)), []);

  if (!state) return null;
  const d = state.dictation;
  const edge = state.prefs.barEdge;
  const notice = state.bar.notice;
  const idle = d.status === 'idle';
  const active = d.status === 'initializing' || d.status === 'listening';

  let pill: PillState;
  if (active) pill = d.handsFree ? 'popo' : 'ptt';
  else if (!idle) pill = 'processing';
  else if (notice?.status === 'error') pill = 'error';
  else pill = hot ? 'ready' : 'resting';

  const hiddenByUser = !state.prefs.showBar || state.prefs.barHiddenUntil > Date.now();
  // En reposo, un aviso que no es de error ocupa el sitio de la píldora.
  const noticeReplacesPill = idle && !!notice && notice.status !== 'error';
  const pillVisible = !noticeReplacesPill && !(idle && hiddenByUser && pill !== 'error');

  return (
    <div className="stage" data-edge={edge}>
      {notice && <NoticeCard key={notice.id} notice={notice} edge={edge} raised={!noticeReplacesPill} />}
      <div className="dock" data-visible={pillVisible}>
        <div className="hot-area" data-hot={pillVisible ? '' : undefined}>
          <div className="tooltip" data-visible={pill === 'ready' && pillHover}>
            Dictate <b>{pttLabel(state.prefs.shortcuts)}</b>
          </div>
          <Pill
            state={pill}
            edge={edge}
            level={d.level}
            micActive={d.status === 'listening'}
            draggable={idle}
          />
        </div>
      </div>
    </div>
  );
}

function Pill({
  state,
  edge,
  level,
  micActive,
  draggable,
}: {
  state: PillState;
  edge: BarEdge;
  level: number;
  micActive: boolean;
  draggable: boolean;
}) {
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    press.current = { x: e.screenX, y: e.screenY, dragging: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const p = press.current;
    if (!p || !draggable) return;
    if (!p.dragging && Math.hypot(e.screenX - p.x, e.screenY - p.y) >= DRAG_THRESHOLD) {
      p.dragging = true;
      api.drag({ phase: 'start', x: p.x, y: p.y });
    }
    if (p.dragging) api.drag({ phase: 'move', x: e.screenX, y: e.screenY });
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.dragging) api.drag({ phase: 'end', x: e.screenX, y: e.screenY });
    else if (state === 'ready') api.command({ type: 'start' });
  };

  return (
    <div
      className="pill"
      data-state={state}
      data-edge={edge}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        api.command({ type: 'menu' });
      }}
    >
      <button className="round cancel" tabIndex={-1} aria-label="Cancel" onClick={() => api.command({ type: 'cancel' })}>
        <CloseIcon size={13} strokeWidth={2.6} />
      </button>
      <span className="mic">
        <MicIcon size={19} strokeWidth={2.5} />
      </span>
      <Wave level={level} live={micActive && (state === 'ptt' || state === 'popo')} edge={edge} />
      <Spinner />
      <button className="round stop" tabIndex={-1} aria-label="Stop" onClick={() => api.command({ type: 'stop' })}>
        <CheckIcon size={15} strokeWidth={2.4} />
      </button>
    </div>
  );
}

/** Onda: barras cuya altura sigue al nivel del micrófono, con una ondulación continua encima. */
function Wave({ level, live, edge }: { level: number; live: boolean; edge: BarEdge }) {
  // El cuadrado da más contraste entre silencio y voz.
  const scale = live ? 1 + level * level * 4 : 1;
  return (
    <span className="wave" data-live={live} data-edge={edge} style={{ '--audio-scale': scale } as React.CSSProperties}>
      {Array.from({ length: WAVE_BARS }, (_, i) => (
        <span key={i} className="wave-bar" style={{ '--bar-height-scale': WAVE_PROFILE[i] } as React.CSSProperties}>
          <span className="wave-bar-inner" style={{ animationDelay: `${-((i * 0.37) % 1).toFixed(2)}s` }} />
        </span>
      ))}
    </span>
  );
}

function Spinner() {
  return (
    <span className="spinner" aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <span
          key={i}
          style={{ transform: `rotate(${i * 45}deg)`, animationDelay: `${(-1.1 * (8 - i)) / 8}s` }}
        />
      ))}
    </span>
  );
}

function NoticeCard({ notice, edge, raised }: { notice: Notice; edge: BarEdge; raised: boolean }) {
  const [paused, setPaused] = useState(false);
  const close = useCallback(
    (why: 'closed' | 'timeout') => api.command({ type: 'notice-closed', id: notice.id, why }),
    [notice.id],
  );
  const flagged = notice.status === 'error' || notice.status === 'alert';
  return (
    <div
      className="card"
      data-edge={edge}
      data-raised={raised}
      data-hot=""
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="card-header">
        {flagged ? (
          <div className="card-title-row">
            {notice.status === 'error' ? (
              <ErrorIcon size={18} className="status-icon error" />
            ) : (
              <AlertIcon size={18} className="status-icon alert" />
            )}
            <span className="card-title">{rich(notice.title)}</span>
          </div>
        ) : notice.badge ? (
          <div className="badge">
            <InfoIcon size={12} />
            <span>{notice.badge}</span>
          </div>
        ) : (
          <div />
        )}
        <CloseRing timeoutMs={notice.timeoutMs} paused={paused} onClose={() => close('closed')} onDone={() => close('timeout')} />
      </div>
      {flagged ? (
        notice.body && <div className="card-body">{rich(notice.body)}</div>
      ) : (
        <div className="card-text">
          <span className="card-title">{rich(notice.title)}</span>
          {notice.body && <span className="card-body">{rich(notice.body)}</span>}
        </div>
      )}
      {notice.actions.length > 0 && (
        <div className="card-actions">
          {notice.actions.map((a) => (
            <button
              key={a.action}
              className="action"
              tabIndex={-1}
              onClick={() => api.command({ type: 'notice-action', id: notice.id, action: a.action })}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Botón de cerrar rodeado de un anillo que se consume durante la cuenta atrás. */
function CloseRing({
  timeoutMs,
  paused,
  onClose,
  onDone,
}: {
  timeoutMs: number;
  paused: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <button className="close-ring" tabIndex={-1} aria-label="Close" onClick={onClose}>
      <svg className="ring" width="30" height="30" viewBox="0 0 30 30" aria-hidden>
        <circle className="ring-track" cx="15" cy="15" r={r} />
        {timeoutMs > 0 && (
          <circle
            className="ring-progress"
            cx="15"
            cy="15"
            r={r}
            strokeDasharray={c}
            style={
              {
                '--ring-length': `${c}px`,
                animationDuration: `${timeoutMs}ms`,
                animationPlayState: paused ? 'paused' : 'running',
              } as React.CSSProperties
            }
            onAnimationEnd={onDone}
          />
        )}
      </svg>
      <CloseIcon size={17} strokeWidth={2.2} />
    </button>
  );
}

/** Texto con **negrita** (los atajos de teclado). */
function rich(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part,
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/** El atajo de dictar, como se escribe en macOS. */
function pttLabel(list: ShortcutBinding[]): string {
  const b = firstBinding(list, 'ptt');
  return b ? compactLabel(b.keys, b.names) : 'fn';
}
