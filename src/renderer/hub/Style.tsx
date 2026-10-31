import { FORMATTING_PROVIDERS, type FormattingProvider } from '../../shared/formatting';
import { Badge, Select } from '../settings/controls';
import { useSharedState } from '../useSharedState';

// Página Style › Auto cleanup: cuánto se limpia cada dictado y quién lo hace.
// None pega la transcripción tal cual; Light quita muletillas y arregla la
// puntuación. Es un solo nivel para todas las apps y se aplica al elegirlo.

interface Level {
  id: 'none' | 'light';
  title: string;
  description: string;
  example: string;
}

const LEVELS: Level[] = [
  {
    id: 'none',
    title: 'None',
    description: 'Transcribes exactly what you said, including mistakes',
    example:
      'hey joey, we still on for coffee or? I think we maybe should leave earlier to make it there in time there might um be traffic. What are you thinking?',
  },
  {
    id: 'light',
    title: 'Light',
    description: 'Cleans up filler words and grammar',
    example:
      'Hey Joey, are we still on for coffee? I think we should leave earlier to make it there in time. There might be traffic. What are you thinking?',
  },
];

const PROVIDER_LABELS: Record<FormattingProvider, string> = {
  ollama: 'On this Mac (Ollama)',
  groq: 'Groq (your key)',
  gemini: 'Gemini (your key)',
};

export function StylePage() {
  const state = useSharedState();
  if (!state) return <div className="page style-page" />;
  const on = state.prefs.smartFormatting;
  const f = state.formatting;
  const [badge, tone]: readonly [string, 'ok' | 'warn' | 'error' | 'muted'] = (
    {
      off: ['Off', 'muted'],
      checking: ['Checking…', 'muted'],
      ready: ['Ready', 'ok'],
      no_server: ['Not running', 'warn'],
      no_model: ['Model missing', 'warn'],
      no_key: ['No key', 'warn'],
    } as const
  )[f.status];
  const cloud = f.provider !== 'ollama' ? ' Your dictation, the app name and your dictionary words are sent to this service.' : '';
  const pending = f.status !== 'ready' && f.status !== 'checking' ? ' Until then, dictations are pasted without cleanup.' : '';
  return (
    <div className="page style-page">
      <div className="page-head">
        <h1 className="page-heading">Style</h1>
      </div>
      <div className="dict-toolbar">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected className="tab tab-active">
            Auto cleanup
          </button>
        </div>
      </div>
      <div className="cleanup-banner">
        <h2 className="cleanup-banner-title">Auto Cleanup applies to all your dictations</h2>
        <p>Choose the level of cleanup that's automatically applied every time, across all apps.</p>
        <p className="cleanup-banner-note">
          What you said word for word is never lost. Just go to the three dots next to a recent dictation in Dictation,
          then click “Undo AI edit.”
        </p>
      </div>
      <div className="cleanup-levels" role="radiogroup" aria-label="Cleanup level">
        {LEVELS.map((l) => {
          const selected = (l.id === 'light') === on;
          return (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`cleanup-level ${selected ? 'cleanup-level-selected' : ''}`}
              onClick={() => void window.speech.setPreference('smartFormatting', l.id === 'light')}
            >
              <span className="cleanup-level-title">{l.title}</span>
              <span className="cleanup-level-description">{l.description}</span>
              <span className="cleanup-level-example">{l.example}</span>
            </button>
          );
        })}
      </div>
      {on && (
        <div className="cleanup-provider settings-card">
          <div className="setting-row">
            <div className="setting-text">
              <div className="setting-label">Cleanup with</div>
              <div className="setting-description">
                Model {f.model}.{cloud}
                {f.detail ? ` ${f.detail}` : ''}
                {pending}
              </div>
            </div>
            <div className="setting-control setting-control-wide">
              <Badge tone={tone}>{badge}</Badge>
              <Select
                label="Cleanup with"
                value={f.provider}
                options={FORMATTING_PROVIDERS.map((p) => [p, PROVIDER_LABELS[p]])}
                onChange={(v) => void window.speech.setPreference('formattingProvider', v)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
