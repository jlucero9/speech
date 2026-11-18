import { useState, type ReactNode } from 'react';
import { CLOUD_PROVIDER_NAMES, CLOUD_PROVIDERS, TRANSCRIPTION_MODELS, type ApiKeyResult, type CloudProvider, type TranscriptionEngineId } from '../../shared/engines';
import { FORMATTING_MODELS, type FormattingProvider } from '../../shared/formatting';
import type { SharedState } from '../../shared/state';
import { LOCAL_MODELS } from '../../shared/transcription';
import { ConfirmDialog, useToast } from '../hub/ui';
import { groqUsageText, UsageRing } from '../hub/UsageRing';
import { Badge, Section, Select, SettingRow } from './controls';

// Ajustes › Engines and Keys: quién transcribe, quién limpia, las claves (en el
// llavero de macOS) y, siempre a la vista, qué sale del equipo con cada opción.
// Un motor en la nube no se puede elegir sin su clave.

/** Lo que se vio al comparar los dos al transcribir. */
const TRANSCRIPTION_NOTES: Record<CloudProvider, string> = {
  groq: 'It wrote what was said most faithfully in testing.',
  gemini: "Gemini can skip parts of what you say or add words you didn't say. Groq was more faithful in testing.",
};

const TERMS: Record<CloudProvider, string> = {
  groq: 'Groq says it does not train on what you send and may keep it for up to 30 days to investigate problems.',
  gemini: 'On the free tier, Google may use what you send to improve its products and people may review it. On a paid plan it does not, and keeps it only for a limited time to detect abuse.',
};

export function EnginesPage({ state, onOpenStyle }: { state: SharedState; onOpenStyle: () => void }) {
  const p = state.prefs;
  const hasKey = (c: CloudProvider) => state.apiKeys[c] === 'saved';
  const cloudOption = <T extends string>(c: CloudProvider & T): [T, string, boolean] => [c, hasKey(c) ? CLOUD_PROVIDER_NAMES[c] : `${CLOUD_PROVIDER_NAMES[c]} (add a key)`, !hasKey(c)];
  const engine = p.transcriptionEngine;
  const f = state.formatting;
  return (
    <>
      <h1 className="settings-title">Engines and Keys</h1>
      {!hasKey('groq') && state.apiKeys.groq !== 'locked' && <GroqSetup />}
      <Section title="Who does the work">
        <SettingRow
          label="Transcribe with"
          description={
            engine === 'local'
              ? `${LOCAL_MODELS[state.transcription.model.id].label} (whisper). Nothing leaves this Mac.`
              : `${TRANSCRIPTION_MODELS[engine]}. The audio of each dictation is sent to ${CLOUD_PROVIDER_NAMES[engine]}. ${TRANSCRIPTION_NOTES[engine]}`
          }
        >
          <Select<TranscriptionEngineId>
            label="Transcribe with"
            value={engine}
            options={[
              ['local', 'On this Mac'],
              ...CLOUD_PROVIDERS.map((c) => cloudOption<TranscriptionEngineId>(c)),
            ]}
            onChange={(v) => void window.speech.setPreference('transcriptionEngine', v)}
          />
        </SettingRow>
        <Disclosure label="Groq or Gemini for transcription">
          In testing, Groq wrote down what was said. Gemini sometimes skipped parts of long dictations or added words nobody said, so Groq is the better choice if you transcribe in the cloud.
        </Disclosure>
        <SettingRow
          label="Clean up with"
          description={
            !p.smartFormatting ? (
              <>
                Auto cleanup is set to None, so this isn't used and nothing is sent.{' '}
                <button type="button" className="inline-link" onClick={onOpenStyle}>
                  Change the level in Style
                </button>
              </>
            ) : (
              <>
                {p.formattingProvider === 'ollama' ? `${FORMATTING_MODELS.ollama} (Ollama)` : FORMATTING_MODELS[p.formattingProvider]}.{' '}
                {p.formattingProvider === 'ollama' ? 'Nothing leaves this Mac.' : `Your transcript, the app name and your dictionary words are sent to ${CLOUD_PROVIDER_NAMES[p.formattingProvider]}.`}
                {f.detail ? ` ${f.detail}` : ''}
              </>
            )
          }
        >
          <Select<FormattingProvider>
            label="Clean up with"
            value={p.formattingProvider}
            options={[['ollama', 'On this Mac'], ...CLOUD_PROVIDERS.map((c) => cloudOption<FormattingProvider>(c))]}
            onChange={(v) => void window.speech.setPreference('formattingProvider', v)}
          />
        </SettingRow>
      </Section>
      {hasKey('groq') && (
        <Section title="Groq usage">
          <SettingRow
            label={state.cloudUsage.groq.limitedUntil ? 'Limit reached' : `${state.cloudUsage.groq.percent}% used in the last 24 hours`}
            description={`${state.cloudUsage.groq.limitedUntil ? `${groqUsageText(state)} ` : ''}Groq's free plan has a daily allowance; what you used a day ago frees up as time passes. At 100%, Groq stops accepting dictations for a while and they stay in your history to retry.`}
          >
            <UsageRing percent={state.cloudUsage.groq.percent} size={32} stroke={4} />
          </SettingRow>
        </Section>
      )}
      <Section title="API keys">
        {CLOUD_PROVIDERS.map((c) => (
          <KeyRow key={c} provider={c} state={state} />
        ))}
      </Section>
      <Section title="What leaves this Mac">
        <Disclosure label="On this Mac (default)">
          Nothing you dictate. Transcription runs in whisper and cleanup in Ollama, both on this Mac. The only download is the speech model, the first time.
        </Disclosure>
        <Disclosure label="Transcribe with Groq or Gemini">
          The audio of each dictation and your dictionary words. Retrying a dictation from your history sends its audio again.
        </Disclosure>
        <Disclosure label="Clean up with Groq or Gemini">
          The transcript of each dictation, the name of the app you're dictating in and your dictionary words.
        </Disclosure>
        <Disclosure label="Never sent">The text around your cursor and your replacements stay on this Mac with every option.</Disclosure>
        {CLOUD_PROVIDERS.map((c) => (
          <Disclosure key={c} label={`${CLOUD_PROVIDER_NAMES[c]} terms`}>
            {TERMS[c]}
          </Disclosure>
        ))}
      </Section>
    </>
  );
}

/** Los pasos para conseguir una clave de Groq: gratis, en un par de minutos. */
function GroqSetup() {
  return (
    <Section title="Make dictation instant with Groq">
      <div className="groq-setup">
        <p className="groq-setup-lead">
          Groq transcribes and cleans up your dictation in about a second, instead of several on this Mac. It's free and takes about two minutes.
        </p>
        <ol className="groq-setup-steps">
          <li>
            <button type="button" className="inline-link" onClick={() => void window.speech.openGroqKeys()}>
              Open console.groq.com/keys
            </button>{' '}
            and sign in with Google, GitHub or your email.
          </li>
          <li>
            Click <strong>Create API Key</strong>, give it any name and copy the key. It starts with <code>gsk_</code>.
          </li>
          <li>
            Click <strong>Add</strong> next to Groq below and paste it. Speech switches to Groq right away.
          </li>
        </ol>
      </div>
    </Section>
  );
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return <SettingRow label={label} description={children} />;
}

function KeyRow({ provider, state }: { provider: CloudProvider; state: SharedState }) {
  const status = state.apiKeys[provider];
  const name = CLOUD_PROVIDER_NAMES[provider];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const toast = useToast();
  const run = async (action: () => Promise<ApiKeyResult>, done: string | null): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const r = await action().finally(() => setBusy(false));
    if (r.ok) {
      if (done) toast(done);
      return true;
    }
    setError(r.message);
    return false;
  };
  const save = async () => {
    const p = state.prefs;
    const switches = provider === 'groq' && status !== 'saved' && status !== 'locked' && p.transcriptionEngine === 'local' && p.formattingProvider === 'ollama';
    if (await run(() => window.speech.saveApiKey(provider, value), switches ? 'Groq key saved. Speech now uses Groq.' : `${name} key saved`)) {
      setValue('');
      setEditing(false);
    }
  };
  const description = error ?? (status === 'saved' ? 'Saved in your macOS Keychain.' : status === 'locked' ? 'macOS asks again after Speech is updated. Use Allow and choose Always Allow.' : status === 'unavailable' ? 'The macOS Keychain is not available.' : 'Not added. Stored only in your macOS Keychain.');
  return (
    <>
      <SettingRow label={name} description={description} wide>
        <Badge tone={status === 'saved' ? 'ok' : status === 'locked' || status === 'unavailable' ? 'warn' : 'muted'}>
          {status === 'saved' ? 'Saved' : status === 'locked' ? 'Locked' : status === 'unavailable' ? 'Unavailable' : 'No key'}
        </Badge>
        {status === 'locked' && (
          <button type="button" className="hub-button hub-button-primary" disabled={busy} onClick={() => void run(() => window.speech.allowApiKey(provider), `${name} key allowed`)}>
            Allow…
          </button>
        )}
        {status === 'saved' && (
          <button type="button" className="hub-button hub-button-secondary" disabled={busy} onClick={() => void run(() => window.speech.testApiKey(provider), `${name} accepted this key`)}>
            Test
          </button>
        )}
        <button type="button" className="hub-button hub-button-secondary" disabled={busy} onClick={() => setEditing((e) => !e)}>
          {status === 'missing' || status === 'unknown' ? 'Add' : 'Replace'}
        </button>
        {(status === 'saved' || status === 'locked') && (
          <button type="button" className="hub-button hub-button-secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove
          </button>
        )}
        {confirmRemove && (
          <ConfirmDialog
            title={`Remove your ${name} key?`}
            body={`Speech can't show your key, so you'd have to paste it again or create a new one in ${name}. Anything using ${name} goes back to running on this Mac.`}
            confirm="Remove"
            onCancel={() => setConfirmRemove(false)}
            onConfirm={() => {
              setConfirmRemove(false);
              void run(() => window.speech.removeApiKey(provider), `${name} key removed`);
            }}
          />
        )}
      </SettingRow>
      {editing && (
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            className="key-input"
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-label={`${name} API key`}
            placeholder={`Paste your ${name} API key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className="hub-button hub-button-primary" disabled={busy || !value.trim()}>
            Save
          </button>
        </form>
      )}
    </>
  );
}
