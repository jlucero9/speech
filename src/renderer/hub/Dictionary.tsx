// Página Dictionary: palabras que el dictado debe escribir bien y
// sustituciones («cuando digas esto, escribe esto otro»), con búsqueda,
// pestañas, destacadas, borrado múltiple e importación desde un fichero.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MAX_PHRASE_CHARS,
  MAX_REPLACEMENT_CHARS,
  type DictionaryEntry,
  type DictionaryImportPreview,
  type DictionaryInput,
} from '../../shared/dictionary';
import {
  ArrowRightIcon,
  BookIcon,
  CheckIcon,
  CloseIcon,
  ImportIcon,
  InfoIcon,
  PencilIcon,
  SearchIcon,
  SelectIcon,
  SortIcon,
  StarIcon,
  TrashIcon,
} from './icons';
import { ConfirmDialog, IconButton, Menu, useToast, type MenuItem } from './ui';

type Tab = 'all' | 'words' | 'replacements' | 'starred';
type Sort = 'newest' | 'oldest' | 'az';

const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'words', label: 'Words' },
  { id: 'replacements', label: 'Replacements' },
  { id: 'starred', label: 'Starred' },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: 'newest', label: 'Newest first' },
  { id: 'oldest', label: 'Oldest first' },
  { id: 'az', label: 'A to Z' },
];

type ListState = { status: 'loading' } | { status: 'ready'; entries: DictionaryEntry[] } | { status: 'error'; message: string };

/** Lee la lista y la vuelve a leer con cada cambio que avisa main; solo cuenta la última respuesta. */
function useDictionary(): ListState {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    window.speech.listDictionary().then(
      (entries) => n === seq.current && setState({ status: 'ready', entries }),
      (err: Error) => n === seq.current && setState({ status: 'error', message: err.message }),
    );
  }, []);
  useEffect(load, [load]);
  useEffect(() => window.speech.onDictionaryChanged(load), [load]);
  return state;
}

type Editing = { mode: 'add' } | { mode: 'edit'; entry: DictionaryEntry };

export function DictionaryPage() {
  const state = useDictionary();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [importing, setImporting] = useState<DictionaryImportPreview | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const closeSort = useCallback(() => setSortAnchor(null), []);

  const entries = state.status === 'ready' ? state.entries : [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries.filter((e) => {
      if (tab === 'words' && e.replacement != null) return false;
      if (tab === 'replacements' && e.replacement == null) return false;
      if (tab === 'starred' && !e.starred) return false;
      return !q || e.phrase.toLowerCase().includes(q) || !!e.replacement?.toLowerCase().includes(q);
    });
    if (sort === 'oldest') list.reverse();
    else if (sort === 'az') list.sort((a, b) => a.phrase.localeCompare(b.phrase, undefined, { sensitivity: 'base' }));
    return list;
  }, [entries, tab, sort, query]);

  // Lo seleccionado que ya no existe (borrado desde otra parte) deja de contar.
  useEffect(() => {
    setSelected((cur) => {
      const ids = new Set(entries.map((e) => e.id));
      const next = new Set([...cur].filter((id) => ids.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [entries]);

  const chooseFile = async () => {
    const r = await window.speech.chooseDictionaryFile();
    if (!r.ok) toast(r.message);
    else if (r.preview) setImporting(r.preview);
  };

  const remove = async (e: DictionaryEntry) => {
    await window.speech.removeWords([e.id]);
    toast(`Deleted “${e.phrase}”`, {
      label: 'Undo',
      run: () => void restore([e], toast),
    });
  };

  const removeSelected = async () => {
    const gone = entries.filter((e) => selected.has(e.id));
    setConfirmDelete(false);
    const n = await window.speech.removeWords(gone.map((e) => e.id));
    setSelected(new Set());
    setSelecting(false);
    toast(`Deleted ${n} ${n === 1 ? 'entry' : 'entries'}`, { label: 'Undo', run: () => void restore(gone, toast) });
  };

  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const empty = state.status === 'ready' && entries.length === 0;

  return (
    <div className="page dictionary-page">
      <div className="page-head">
        <h1 className="page-heading">Dictionary</h1>
        <button type="button" className="hub-button hub-button-primary" onClick={() => setEditing({ mode: 'add' })}>
          Add new
        </button>
      </div>

      {state.status === 'loading' && <div className="history-loading" aria-busy />}
      {state.status === 'error' && (
        <div className="history-empty">
          <h2 className="history-empty-title">Couldn't load your dictionary</h2>
          <p className="history-empty-body">{state.message}</p>
        </div>
      )}
      {empty && <EmptyDictionary onAdd={() => setEditing({ mode: 'add' })} onImport={() => void chooseFile()} />}

      {state.status === 'ready' && !empty && (
        <>
          <div className="dict-toolbar">
            <div className="tabs" role="tablist">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`tab ${tab === t.id ? 'tab-active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="dict-tools">
              {searchOpen ? (
                <div className="search-box">
                  <SearchIcon size={16} />
                  <input
                    autoFocus
                    className="search-input"
                    placeholder="Search your dictionary"
                    aria-label="Search your dictionary"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape') return;
                      setSearchOpen(false);
                      setQuery('');
                    }}
                  />
                  <button
                    type="button"
                    className="search-close"
                    aria-label="Close search"
                    onClick={() => {
                      setSearchOpen(false);
                      setQuery('');
                    }}
                  >
                    <CloseIcon size={14} strokeWidth={2} />
                  </button>
                </div>
              ) : (
                <IconButton label="Search" onClick={() => setSearchOpen(true)}>
                  <SearchIcon size={18} />
                </IconButton>
              )}
              <IconButton label="Sort" active={!!sortAnchor} onClick={(e) => setSortAnchor(sortAnchor ? null : e.currentTarget)}>
                <SortIcon size={18} />
              </IconButton>
              <IconButton label="Select" active={selecting} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
                <SelectIcon size={18} />
              </IconButton>
              <IconButton label="Import from a file" onClick={() => void chooseFile()}>
                <ImportIcon size={18} />
              </IconButton>
            </div>
          </div>

          {selecting && (
            <div className="dict-selection">
              <span>
                {selected.size === 0 ? 'Select words to delete' : `${selected.size} selected`}
              </span>
              <div className="dict-selection-actions">
                <button
                  type="button"
                  className="link"
                  onClick={() => setSelected(selected.size === shown.length ? new Set() : new Set(shown.map((e) => e.id)))}
                >
                  {selected.size === shown.length && shown.length > 0 ? 'Select none' : 'Select all'}
                </button>
                <button
                  type="button"
                  className="hub-button hub-button-destructive hub-button-sm"
                  disabled={selected.size === 0}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </button>
                <button type="button" className="hub-button hub-button-secondary hub-button-sm" onClick={stopSelecting}>
                  Done
                </button>
              </div>
            </div>
          )}

          {shown.length === 0 ? (
            <p className="history-no-results">{query.trim() ? `Nothing found for “${query.trim()}”` : emptyTabText(tab)}</p>
          ) : (
            <ul className="dict-list">
              {shown.map((e) => (
                <DictionaryRow
                  key={e.id}
                  entry={e}
                  selecting={selecting}
                  selected={selected.has(e.id)}
                  onToggleSelected={() =>
                    setSelected((cur) => {
                      const next = new Set(cur);
                      if (!next.delete(e.id)) next.add(e.id);
                      return next;
                    })
                  }
                  onEdit={() => setEditing({ mode: 'edit', entry: e })}
                  onDelete={() => void remove(e)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {sortAnchor && (
        <Menu
          anchor={sortAnchor}
          onClose={closeSort}
          items={SORTS.map(
            (o): MenuItem => ({
              label: o.label,
              icon: <CheckIcon size={18} className={sort === o.id ? '' : 'invisible'} />,
              onSelect: () => setSort(o.id),
            }),
          )}
        />
      )}
      {editing && <WordDialog editing={editing} onClose={() => setEditing(null)} />}
      {importing && <ImportDialog preview={importing} onClose={() => setImporting(null)} />}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${selected.size} ${selected.size === 1 ? 'entry' : 'entries'}?`}
          body="They will no longer be used when you dictate."
          confirm="Yes, delete"
          onConfirm={() => void removeSelected()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/** «Undo» de un borrado. */
async function restore(entries: DictionaryEntry[], toast: (text: string) => void) {
  const n = await window.speech.restoreWords(entries);
  if (n < entries.length) toast('Some entries could not be restored');
}

function emptyTabText(tab: Tab): string {
  switch (tab) {
    case 'words':
      return 'No words yet';
    case 'replacements':
      return 'No replacements yet. Turn on “Correct a misspelling” when you add one.';
    case 'starred':
      return 'No starred entries. Star the ones that matter most: they always go first.';
    default:
      return 'Nothing here yet';
  }
}

function EmptyDictionary({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }) {
  return (
    <div className="history-empty">
      <div className="history-empty-icon">
        <BookIcon size={20} />
      </div>
      <h2 className="history-empty-title">Your dictionary is empty</h2>
      <p className="history-empty-body">
        Add names, jargon and uncommon words so they're always spelled right, or a replacement that types something else
        when you say it.
      </p>
      <div className="empty-actions">
        <button type="button" className="hub-button hub-button-primary" onClick={onAdd}>
          Add new word
        </button>
        <button type="button" className="hub-button hub-button-secondary" onClick={onImport}>
          Import from a file
        </button>
      </div>
    </div>
  );
}

// MARK: Fila

function DictionaryRow({
  entry: e,
  selecting,
  selected,
  onToggleSelected,
  onEdit,
  onDelete,
}: {
  entry: DictionaryEntry;
  selecting: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const label = e.replacement != null ? `${e.phrase} → ${e.replacement}` : e.phrase;
  return (
    <li
      className={`dict-row ${selected ? 'dict-row-selected' : ''} ${selecting ? 'dict-row-selecting' : ''}`}
      data-id={e.id}
      onClick={selecting ? onToggleSelected : undefined}
      onDoubleClick={selecting ? undefined : onEdit}
    >
      {selecting && (
        <span className={`checkbox ${selected ? 'checkbox-on' : ''}`} role="checkbox" aria-checked={selected} aria-label={label}>
          {selected && <CheckIcon size={14} strokeWidth={2.5} />}
        </span>
      )}
      <p className="dict-text">
        {e.replacement != null ? (
          <>
            <span>{e.phrase}</span>
            <ArrowRightIcon size={15} strokeWidth={2} className="dict-arrow" />
            <span>{e.replacement}</span>
          </>
        ) : (
          e.phrase
        )}
      </p>
      {e.starred && <StarIcon size={16} filled className="dict-star-mark" />}
      {!selecting && (
        <div className="history-actions dict-actions">
          <IconButton label="Edit" onClick={onEdit}>
            <PencilIcon size={20} />
          </IconButton>
          <IconButton label="Delete" onClick={onDelete}>
            <TrashIcon size={20} />
          </IconButton>
          <IconButton
            label={e.starred ? 'Unstar' : 'Star'}
            active={e.starred}
            onClick={() => void window.speech.starWord(e.id, !e.starred)}
          >
            <StarIcon size={20} filled={e.starred} />
          </IconButton>
        </div>
      )}
    </li>
  );
}

// MARK: Diálogo de alta y edición

function WordDialog({ editing, onClose }: { editing: Editing; onClose: () => void }) {
  const toast = useToast();
  const initial = editing.mode === 'edit' ? editing.entry : null;
  const [isReplacement, setIsReplacement] = useState(initial?.replacement != null);
  const [phrase, setPhrase] = useState(initial?.phrase ?? '');
  const [replacement, setReplacement] = useState(initial?.replacement ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, [isReplacement]);

  const valid = phrase.trim() !== '' && (!isReplacement || replacement.trim() !== '');
  const title =
    editing.mode === 'add' ? 'Add to dictionary' : initial?.replacement != null ? 'Edit replacement' : 'Edit word';

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    const input: DictionaryInput = { phrase, replacement: isReplacement ? replacement : null };
    const r = editing.mode === 'add' ? await window.speech.addWord(input) : await window.speech.editWord(editing.entry.id, input);
    setSaving(false);
    if (!r.ok) return setError(r.message);
    onClose();
    if (editing.mode === 'add') toast(isReplacement ? 'Replacement added' : `Added “${phrase.trim()}”`);
  };

  return (
    <Modal onClose={onClose} className="word-dialog" labelledBy="word-dialog-title">
      <form
        className="word-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 id="word-dialog-title" className="modal-title">
          {title}
        </h2>
        <div className="toggle-row">
          <span className="toggle-label">
            Correct a misspelling
            <span
              className="info-hint"
              data-tooltip="Whenever this word or phrase comes out of a dictation, it's replaced with your spelling."
              tabIndex={0}
            >
              <InfoIcon size={16} />
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={isReplacement}
            aria-label="Correct a misspelling"
            className={`switch ${isReplacement ? 'switch-on' : ''}`}
            onClick={() => {
              setIsReplacement((v) => !v);
              setError(null);
            }}
          >
            <span className="switch-thumb" />
          </button>
        </div>
        {isReplacement ? (
          <div className="replacement-fields">
            <input
              ref={first}
              className="text-field"
              placeholder="Misspelling"
              aria-label="Misspelling"
              maxLength={MAX_PHRASE_CHARS}
              value={phrase}
              onChange={(e) => {
                setPhrase(e.target.value);
                setError(null);
              }}
            />
            <ArrowRightIcon size={18} className="replacement-arrow" />
            <input
              className="text-field"
              placeholder="Correct spelling"
              aria-label="Correct spelling"
              maxLength={MAX_REPLACEMENT_CHARS}
              value={replacement}
              onChange={(e) => {
                setReplacement(e.target.value);
                setError(null);
              }}
            />
          </div>
        ) : (
          <input
            ref={first}
            className="text-field"
            placeholder="Add a new word"
            aria-label="Word"
            maxLength={MAX_PHRASE_CHARS}
            value={phrase}
            onChange={(e) => {
              setPhrase(e.target.value);
              setError(null);
            }}
          />
        )}
        {error && <p className="field-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="hub-button hub-button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="hub-button hub-button-primary" disabled={!valid || saving}>
            {editing.mode === 'add' ? (isReplacement ? 'Add replacement' : 'Add word') : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// MARK: Importación

function ImportDialog({ preview, onClose }: { preview: DictionaryImportPreview; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const n = preview.items.length;
  const notes = [
    preview.duplicates ? `${preview.duplicates} already in your dictionary` : null,
    preview.skipped ? `${preview.skipped} ${preview.skipped === 1 ? 'line' : 'lines'} skipped` : null,
  ].filter(Boolean);

  const run = async () => {
    setBusy(true);
    const added = await window.speech.importDictionary(preview.items);
    onClose();
    toast(`Imported ${added} ${added === 1 ? 'entry' : 'entries'}`);
  };

  return (
    <Modal onClose={onClose} className="import-dialog" labelledBy="import-title">
      <div className="word-form">
        <div>
          <h2 id="import-title" className="modal-title">
            {n ? `Import ${n} ${n === 1 ? 'entry' : 'entries'}?` : 'Nothing new to import'}
          </h2>
          <p className="confirm-body">
            From “{preview.fileName}”{notes.length ? ` · ${notes.join(' · ')}` : ''}
          </p>
        </div>
        {n > 0 && (
          <ul className="import-preview">
            {preview.items.slice(0, 50).map((i) => (
              <li key={i.phrase}>{i.replacement != null ? `${i.phrase} → ${i.replacement}` : i.phrase}</li>
            ))}
            {n > 50 && <li className="muted-row">and {n - 50} more</li>}
          </ul>
        )}
        <div className="modal-actions">
          <button type="button" className="hub-button hub-button-secondary" onClick={onClose}>
            {n ? 'Cancel' : 'Close'}
          </button>
          {n > 0 && (
            <button type="button" className="hub-button hub-button-primary" disabled={busy} onClick={() => void run()}>
              Import
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// MARK: Modal

function Modal({
  onClose,
  className,
  labelledBy,
  children,
}: {
  onClose: () => void;
  className: string;
  labelledBy: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className}`} role="dialog" aria-modal aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
