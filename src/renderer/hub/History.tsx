// Historial de dictados: agrupado por día, con búsqueda, reproducción del
// audio y las acciones de cada fila.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hasAiEdit, shownText, type HistoryEntry, type HistoryPage } from '../../shared/history';
import {
  AlertIcon,
  AudioFileIcon,
  CloseIcon,
  CopyIcon,
  FlagIcon,
  MicIcon,
  MoreIcon,
  PauseIcon,
  PlayIcon,
  RedoIcon,
  RetryIcon,
  SearchIcon,
  TrashIcon,
  UndoIcon,
} from './icons';
import { ConfirmDialog, IconButton, Menu, useToast, type MenuItem } from './ui';

const PAGE = 50;

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; page: HistoryPage; search: string }
  | { status: 'error'; message: string };

/**
 * Lee la lista y la vuelve a leer con cada cambio que avisa main y al volver
 * a la ventana. Solo cuenta la respuesta a la última petición: una lectura
 * vieja que llega tarde no puede pisar a una más nueva (ni dejar la lista
 * vacía con filas en la base).
 */
function useHistoryList(limit: number, search: string): ListState {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    window.speech.listHistory({ limit, search }).then(
      (page) => n === seq.current && setState({ status: 'ready', page, search }),
      (err: Error) => n === seq.current && setState({ status: 'error', message: err.message }),
    );
  }, [limit, search]);
  useEffect(load, [load]);
  useEffect(() => window.speech.onHistoryChanged(load), [load]);
  useEffect(() => {
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);
  return state;
}

export function HistoryList() {
  const [limit, setLimit] = useState(PAGE);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const search = useDebounced(query.trim(), 200);
  const state = useHistoryList(limit, search);
  const player = useAudioPlayer();
  const sentinel = useRef<HTMLDivElement>(null);
  const more = state.status === 'ready' && state.page.more;

  // Al acercarse al final se piden más filas.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && setLimit((l) => l + PAGE), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [more]);

  const groups = useMemo(() => (state.status === 'ready' ? groupByDay(state.page.entries) : []), [state]);

  if (state.status === 'loading') return <div className="history-loading" aria-busy />;
  if (state.status === 'error') {
    return (
      <div className="history-empty">
        <h2 className="history-empty-title">Couldn't load your history</h2>
        <p className="history-empty-body">{state.message}</p>
      </div>
    );
  }
  if (!state.search && !searchOpen && state.page.entries.length === 0) return <EmptyHistory />;

  const searchBox = (
    <SearchBox
      open={searchOpen}
      query={query}
      onOpen={() => setSearchOpen(true)}
      onChange={setQuery}
      onClose={() => {
        setSearchOpen(false);
        setQuery('');
      }}
    />
  );

  return (
    <section className="history" aria-label="Dictation history">
      {groups.length === 0 ? (
        <>
          <div className="history-header">
            <h2 className="history-day">Search</h2>
            {searchBox}
          </div>
          <p className="history-no-results">
            {search ? `No transcripts found for “${search}”` : 'No transcripts yet'}
          </p>
        </>
      ) : (
        groups.map((g, i) => (
          <div key={g.key} className="history-group-wrap">
            <div className="history-header">
              <h2 className="history-day">{g.label}</h2>
              {i === 0 && searchBox}
            </div>
            <ul className="history-group">
              {g.entries.map((e) => (
                <HistoryRow key={e.id} entry={e} player={player} />
              ))}
            </ul>
          </div>
        ))
      )}
      {more && <div ref={sentinel} className="history-more" />}
    </section>
  );
}

function EmptyHistory() {
  return (
    <div className="history-empty">
      <div className="history-empty-icon">
        <MicIcon size={20} />
      </div>
      <h2 className="history-empty-title">No dictations yet</h2>
      <p className="history-empty-body">Once you dictate in any app, your dictation history will appear here.</p>
    </div>
  );
}

function SearchBox({
  open,
  query,
  onOpen,
  onChange,
  onClose,
}: {
  open: boolean;
  query: string;
  onOpen: () => void;
  onChange: (q: string) => void;
  onClose: () => void;
}) {
  if (!open) {
    return (
      <IconButton label="Search past transcripts" onClick={onOpen}>
        <SearchIcon size={18} />
      </IconButton>
    );
  }
  return (
    <div className="search-box">
      <SearchIcon size={16} />
      <input
        autoFocus
        className="search-input"
        placeholder="Search past transcripts"
        aria-label="Search past transcripts"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      />
      <button type="button" className="search-close" aria-label="Close search" onClick={onClose}>
        <CloseIcon size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

// MARK: Fila

function HistoryRow({ entry: e, player }: { entry: HistoryEntry; player: AudioPlayer }) {
  const toast = useToast();
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const closeMenu = useCallback(() => setMenuAnchor(null), []);
  const playing = player.playingId === e.id;
  const text = shownText(e);
  const busy = e.status === 'processing' || e.status === 'recording';
  const aiEdit = hasAiEdit(e);

  const retry = async () => {
    const r = await window.speech.retryTranscript(e.id);
    if (!r.ok) toast(r.message);
  };

  const items: MenuItem[] = [
    e.showFormatted || !aiEdit
      ? {
          label: 'Undo AI edit',
          icon: <UndoIcon size={18} />,
          disabled: !aiEdit || busy,
          hint: 'This transcript has no AI edit',
          onSelect: () => void window.speech.setShowFormatted(e.id, false),
        }
      : {
          label: 'Redo AI edit',
          icon: <RedoIcon size={18} />,
          disabled: busy,
          onSelect: () => void window.speech.setShowFormatted(e.id, true),
        },
    {
      label: 'Retry transcript',
      icon: <RetryIcon size={18} />,
      disabled: !e.hasAudio || busy,
      hint: busy ? 'Already transcribing' : 'The audio is no longer available (older than 14 days)',
      onSelect: () => void retry(),
    },
    {
      label: 'Delete transcript',
      icon: <TrashIcon size={18} />,
      destructive: true,
      onSelect: () => setConfirmDelete(true),
    },
    {
      label: 'Extract audio',
      icon: <AudioFileIcon size={18} />,
      disabled: !e.hasAudio,
      hint: 'The audio is no longer available (older than 14 days)',
      onSelect: async () => {
        const r = await window.speech.extractAudio(e.id);
        if (!r.ok) toast(r.message);
        else if (r.saved) toast('Audio saved');
      },
    },
  ];

  return (
    <li className={`history-row ${menuAnchor ? 'history-row-selected' : ''}`} data-id={e.id}>
      <div className="history-time">{formatTime(e.createdAt)}</div>
      <div className="history-body">
        <RowText entry={e} text={text} busy={busy} onRetry={retry} />
      </div>
      <div className="history-actions">
        <IconButton
          label={playing ? 'Pause audio' : 'Play audio'}
          active={playing}
          onClick={() => {
            if (playing) return player.stop();
            if (!e.hasAudio) return toast("Can't play the audio: it's no longer available (older than 14 days)");
            void player.play(e.id).then((ok) => ok || toast("Can't play the audio: it's no longer available"));
          }}
        >
          {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
        </IconButton>
        <IconButton
          label="Copy transcript"
          onClick={async () => {
            const r = await window.speech.copyTranscript(e.id);
            toast(r.ok ? 'Transcript copied' : r.message);
          }}
        >
          <CopyIcon size={20} />
        </IconButton>
        <IconButton
          label={e.flagged ? 'Remove flag' : 'Flag transcript'}
          active={e.flagged}
          onClick={() => void window.speech.setFlagged(e.id, !e.flagged)}
        >
          <FlagIcon size={20} filled={e.flagged} />
        </IconButton>
        <IconButton
          label="More options"
          active={!!menuAnchor}
          onClick={(ev) => {
            const target = ev.currentTarget;
            setMenuAnchor((cur) => (cur ? null : target));
          }}
        >
          <MoreIcon size={20} />
        </IconButton>
      </div>
      {e.flagged && <FlagIcon size={14} filled className="history-flag-mark" />}
      {menuAnchor && <Menu anchor={menuAnchor} items={items} onClose={closeMenu} />}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this transcript?"
          body="Its text and audio are deleted from this Mac. This can't be undone."
          confirm="Yes, delete it"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setConfirmDelete(false);
            if (playing) player.stop();
            const r = await window.speech.deleteTranscript(e.id);
            toast(r.ok ? 'Transcript deleted' : r.message);
          }}
        />
      )}
    </li>
  );
}

function RowText({
  entry: e,
  text,
  busy,
  onRetry,
}: {
  entry: HistoryEntry;
  text: string | null;
  busy: boolean;
  onRetry: () => void;
}) {
  if (busy) {
    return (
      <p className="history-text history-text-muted">
        <span className="spinner" aria-hidden />
        Transcribing…
      </p>
    );
  }
  if (e.status === 'failed') {
    const interrupted = e.error?.startsWith('interrupted') ?? false;
    return (
      <p className="history-text history-text-error">
        <AlertIcon size={16} className="history-text-icon" />
        <span>
          {interrupted ? 'This transcription was interrupted. ' : 'This transcription failed. '}
          {e.hasAudio && (
            <button type="button" className="link" onClick={onRetry}>
              Retry
            </button>
          )}
        </span>
      </p>
    );
  }
  if (e.status === 'cancelled' && !text?.trim()) {
    return (
      <p className="history-text history-text-muted">
        <span>
          This transcription was cancelled.{' '}
          {e.hasAudio && (
            <button type="button" className="link" onClick={onRetry}>
              Recover
            </button>
          )}
        </span>
      </p>
    );
  }
  if (!text?.trim()) {
    return (
      <p className="history-text history-text-muted" title="No words were detected in this dictation, so the transcript is empty.">
        Audio is silent.
      </p>
    );
  }
  return <p className="history-text">{text}</p>;
}

// MARK: Audio

interface AudioPlayer {
  playingId: string | null;
  play(id: string): Promise<boolean>;
  stop(): void;
}

/** Un solo reproductor para toda la lista: empezar otro audio para el anterior. */
function useAudioPlayer(): AudioPlayer {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);

  const stop = useCallback(() => {
    audio.current?.pause();
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    audio.current = null;
    setPlayingId(null);
  }, []);

  const play = useCallback(
    async (id: string) => {
      stop();
      const bytes = await window.speech.historyAudio(id);
      if (!bytes) return false;
      const src = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
      const a = new Audio(src);
      url.current = src;
      audio.current = a;
      a.onended = () => audio.current === a && stop();
      setPlayingId(id);
      try {
        await a.play();
        return true;
      } catch {
        stop();
        return false;
      }
    },
    [stop],
  );

  useEffect(() => stop, [stop]);
  return { playingId, play, stop };
}

// MARK: Fechas

interface DayGroup {
  key: string;
  label: string;
  entries: HistoryEntry[];
}

function groupByDay(entries: HistoryEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const e of entries) {
    const d = new Date(e.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    let g = groups[groups.length - 1];
    if (g?.key !== key) {
      g = { key, label: dayLabel(d), entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}

function dayLabel(d: Date): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

/** «5:32pm». */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
