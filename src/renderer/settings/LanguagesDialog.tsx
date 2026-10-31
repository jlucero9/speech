import { useEffect, useMemo, useRef, useState } from 'react';
import type { SharedState } from '../../shared/state';
import { DICTATION_LANGUAGE_NATIVE, DICTATION_LANGUAGES, languageLabel } from '../../shared/transcription';
import { SearchIcon } from '../hub/icons';

// Idioma del dictado. Siempre uno: detectar el idioma en cada dictado cuesta
// otra pasada del modelo, así que elegir otro sustituye al anterior. Se guarda
// con «Save and close».

export function LanguagesDialog({ state, onClose }: { state: SharedState; onClose: () => void }) {
  const [selected, setSelected] = useState(state.prefs.dictationLanguage);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);

  // Inglés y español primero, como los más usados; el resto por orden alfabético.
  const codes = useMemo(() => {
    const rest = Object.keys(DICTATION_LANGUAGES)
      .filter((c) => c !== 'en' && c !== 'es')
      .sort((a, b) => DICTATION_LANGUAGES[a].localeCompare(DICTATION_LANGUAGES[b]));
    return ['en', 'es', ...rest];
  }, []);
  const q = query.trim().toLowerCase();
  const shown = codes.filter(
    (c) => !q || DICTATION_LANGUAGES[c].toLowerCase().includes(q) || DICTATION_LANGUAGE_NATIVE[c]?.toLowerCase().includes(q),
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [onClose]);

  const save = () => {
    if (selected !== state.prefs.dictationLanguage) void window.speech.setPreference('dictationLanguage', selected);
    onClose();
  };

  return (
    <div className="modal-backdrop sub-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal sub-dialog languages-dialog" role="dialog" aria-modal aria-labelledby="languages-title">
        <header className="languages-head">
          <h2 id="languages-title" className="modal-title">
            Dictation languages
          </h2>
          <p className="sub-dialog-subtitle">
            Choose the language you dictate in.
            <br />
            Speech transcribes in one language at a time.
          </p>
        </header>
        <div className="languages-body">
          <div className="languages-picker">
            <label className="languages-search">
              <SearchIcon size={20} />
              <input
                ref={search}
                type="search"
                placeholder="Search for any languages"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
            </label>
            <div className="languages-grid" role="radiogroup" aria-label="Dictation language">
              {shown.map((c) => {
                const native = DICTATION_LANGUAGE_NATIVE[c];
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={c === selected}
                    className={`language-cell ${c === selected ? 'language-cell-selected' : ''}`}
                    onClick={() => setSelected(c)}
                  >
                    <span className="language-name">{DICTATION_LANGUAGES[c]}</span>
                    {native && native !== DICTATION_LANGUAGES[c] && <span className="language-native">{native}</span>}
                  </button>
                );
              })}
              {shown.length === 0 && <p className="muted languages-empty">No matches found</p>}
            </div>
          </div>
          <aside className="languages-side">
            <h3 className="languages-selected-title">Selected</h3>
            <ul className="languages-selected">
              <li>{languageLabel(selected)}</li>
            </ul>
            <button type="button" className="hub-button hub-button-primary languages-save" onClick={save}>
              Save and close
            </button>
          </aside>
        </div>
      </div>
    </div>
  );
}
