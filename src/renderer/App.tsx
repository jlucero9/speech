import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { HistoryStats } from '../shared/history';
import { isHubPage, type HubPage } from '../shared/ipc';
import { HistoryList } from './hub/History';
import { BookIcon, CloseIcon, GearIcon, LogoMark, MicIcon, SidebarIcon } from './hub/icons';
import { ToastProvider } from './hub/ui';
import { ProvisionalSettings } from './settings/ProvisionalSettings';
import { useSharedState } from './useSharedState';

// El Hub: barra lateral con las páginas, el contenido en una tarjeta a la
// derecha y los ajustes en un diálogo encima.

type Page = Exclude<HubPage, 'settings'>;

export function App() {
  const initial = location.hash.slice(1);
  const [page, setPage] = useState<Page>(initial === 'dictionary' ? 'dictionary' : 'dictation');
  const [settingsOpen, setSettingsOpen] = useState(initial === 'settings');
  const [collapsed, setCollapsed] = useState(false);

  // main pide una página al abrir el Hub desde la barra, la bandeja o un aviso.
  useEffect(
    () =>
      window.speech.onNavigate((p) => {
        if (!isHubPage(p)) return;
        if (p === 'settings') setSettingsOpen(true);
        else {
          setSettingsOpen(false);
          setPage(p);
        }
      }),
    [],
  );

  return (
    <ToastProvider>
      <div className={`hub ${collapsed ? 'hub-collapsed' : ''}`}>
        <div className="hub-titlebar">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <SidebarIcon size={20} />
          </button>
        </div>
        <nav className="sidebar" aria-label="Pages">
          <div className="logo">
            <LogoMark size={22} />
            <span className="logo-text">Speech</span>
          </div>
          <ul className="nav">
            <NavItem icon={<MicIcon />} label="Dictation" active={page === 'dictation'} onClick={() => setPage('dictation')} />
            <NavItem icon={<BookIcon />} label="Dictionary" active={page === 'dictionary'} onClick={() => setPage('dictionary')} />
          </ul>
          <div className="nav-bottom">
            <ul className="nav">
              <NavItem icon={<GearIcon />} label="Settings" active={settingsOpen} onClick={() => setSettingsOpen(true)} />
            </ul>
          </div>
        </nav>
        <main className="page-card">
          {page === 'dictation' ? <DictationPage /> : <DictionaryPage />}
        </main>
      </div>
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </ToastProvider>
  );
}

function NavItem({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        className={`nav-item ${active ? 'nav-item-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        title={label}
        onClick={onClick}
      >
        {icon}
        <span className="nav-label">{label}</span>
      </button>
    </li>
  );
}

// MARK: Dictation

function DictationPage() {
  return (
    <div className="page dictation-page">
      <h1 className="greeting">
        Hold <kbd className="key-embossed">fn</kbd> and speak in any app
      </h1>
      <div className="dictation-columns">
        <HistoryList />
        <aside className="dictation-side">
          <StatsCard />
        </aside>
      </div>
    </div>
  );
}

function StatsCard() {
  const stats = useHistoryStats();
  if (!stats) return <div className="stats-card stats-card-loading" />;
  return (
    <div className="stats-card">
      <Stat value={stats.totalWords.toLocaleString('en-US')} label={stats.totalWords === 1 ? 'total word' : 'total words'} />
      <Stat value={stats.wpm != null ? String(stats.wpm) : '–'} label="wpm" />
      <Stat value={String(stats.streakDays)} label="day streak" />
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <p className="stat">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </p>
  );
}

function useHistoryStats(): HistoryStats | null {
  const [stats, setStats] = useState<HistoryStats | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    void window.speech.historyStats().then((s) => n === seq.current && setStats(s));
  }, []);
  useEffect(load, [load]);
  useEffect(() => window.speech.onHistoryChanged(load), [load]);
  return stats;
}

// MARK: Dictionary

function DictionaryPage() {
  return (
    <div className="page">
      <h1 className="page-heading">Dictionary</h1>
      <div className="history-empty">
        <div className="history-empty-icon">
          <BookIcon size={20} />
        </div>
        <h2 className="history-empty-title">Your dictionary is on its way</h2>
        <p className="history-empty-body">Soon you'll be able to add names and words here so they're always spelled right.</p>
      </div>
    </div>
  );
}

// MARK: Settings

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const state = useSharedState();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.menu, .confirm')) onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-dialog" role="dialog" aria-modal aria-labelledby="settings-title">
        <div className="settings-head">
          <h1 id="settings-title" className="page-heading">
            Settings
          </h1>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="settings-body">
          {state ? <ProvisionalSettings state={state} /> : <p className="muted">Loading…</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
