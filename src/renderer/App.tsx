import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { HistoryStats } from '../shared/history';
import { isHubPage, type HubPage } from '../shared/ipc';
import { firstBinding, keyLabel } from '../shared/shortcuts';
import { DictionaryPage } from './hub/Dictionary';
import { HistoryList } from './hub/History';
import { BookIcon, GearIcon, LogoMark, MicIcon, SidebarIcon, TypeIcon } from './hub/icons';
import { StylePage } from './hub/Style';
import { ToastProvider } from './hub/ui';
import { SettingsDialog, type SettingsSection } from './settings/Settings';
import { useSharedState } from './useSharedState';

// El Hub: barra lateral con las páginas, el contenido en una tarjeta a la
// derecha y los ajustes en un diálogo encima.

type Page = 'dictation' | 'dictionary' | 'style';

/** Sección de ajustes de una página «settings…», o null si no es de ajustes. */
function settingsSection(p: HubPage): SettingsSection | null {
  if (p === 'settings') return 'general';
  if (p === 'settings/system') return 'system';
  if (p === 'settings/engines') return 'engines';
  if (p === 'settings/data') return 'data';
  return null;
}

export function App() {
  const initial = location.hash.slice(1);
  const initialPage: HubPage = isHubPage(initial) ? initial : 'dictation';
  const [page, setPage] = useState<Page>(settingsSection(initialPage) ? 'dictation' : (initialPage as Page));
  const [settings, setSettings] = useState<SettingsSection | null>(settingsSection(initialPage));
  const [collapsed, setCollapsed] = useState(false);

  // main pide una página al abrir el Hub desde la barra, la bandeja o un aviso.
  useEffect(
    () =>
      window.speech.onNavigate((p) => {
        if (!isHubPage(p)) return;
        const section = settingsSection(p);
        if (section) setSettings(section);
        else {
          setSettings(null);
          setPage(p as Page);
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
            <NavItem icon={<TypeIcon />} label="Style" active={page === 'style'} onClick={() => setPage('style')} />
          </ul>
          <div className="nav-bottom">
            <ul className="nav">
              <NavItem icon={<GearIcon />} label="Settings" active={settings !== null} onClick={() => setSettings('general')} />
            </ul>
          </div>
        </nav>
        <main className="page-card">
          {page === 'dictation' ? <DictationPage /> : page === 'dictionary' ? <DictionaryPage /> : <StylePage onOpenEngines={() => setSettings('engines')} />}
        </main>
      </div>
      {settings && (
        <SettingsDialog
          section={settings}
          onSection={setSettings}
          onClose={() => setSettings(null)}
          onOpenStyle={() => {
            setSettings(null);
            setPage('style');
          }}
        />
      )}
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
  const state = useSharedState();
  const ptt = state ? firstBinding(state.prefs.shortcuts, 'ptt') : null;
  return (
    <div className="page dictation-page">
      <h1 className="greeting">
        Hold{' '}
        {(ptt?.keys ?? [0x3f]).map((k) => (
          <kbd key={k} className="key-embossed">
            {keyLabel(k, ptt?.names)}
          </kbd>
        ))}{' '}
        and speak in any app
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
