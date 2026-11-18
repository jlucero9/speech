import { isCloudProvider, TRANSCRIPTION_MODELS, type CloudProvider } from '../../shared/engines';
import type { GroqUsage } from '../cloud-usage';
import type { ReadApiKey } from '../keys';
import type { Store } from '../store';
import { GeminiTranscription, GroqTranscription } from './cloud';
import type { TranscriptionEngine, TranscriptionRequest, TranscriptionResult } from './engine';

// El motor visto desde el dictado: el que digan las preferencias en cada momento.

export class TranscriptionEngines implements TranscriptionEngine {
  private readonly cloud: Record<CloudProvider, TranscriptionEngine>;

  constructor(
    private readonly store: Store,
    private readonly local: TranscriptionEngine,
    readKey: ReadApiKey,
    groqUsage?: GroqUsage,
  ) {
    this.cloud = {
      groq: new GroqTranscription(TRANSCRIPTION_MODELS.groq, readKey, groqUsage),
      gemini: new GeminiTranscription(TRANSCRIPTION_MODELS.gemini, readKey),
    };
    let last = store.get().prefs.transcriptionEngine;
    const sync = (id: typeof last) => {
      if (store.get().transcription.engine !== id) {
        store.update((s) => ({ ...s, transcription: { ...s.transcription, engine: id } }));
      }
    };
    sync(last);
    store.subscribe((s) => {
      const next = s.prefs.transcriptionEngine;
      if (next === last) return;
      last = next;
      sync(next);
      // El modelo local no tiene por qué seguir ocupando memoria.
      if (next !== 'local') this.local.release('engine changed');
    });
  }

  private get current(): TranscriptionEngine {
    const id = this.store.get().prefs.transcriptionEngine;
    return isCloudProvider(id) ? this.cloud[id] : this.local;
  }

  get id(): string {
    return this.current.id;
  }

  prepare(language: string): void {
    this.current.prepare(language);
  }

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    return this.current.transcribe(request);
  }

  release(reason: string, whenIdle = false): void {
    this.local.release(reason, whenIdle);
  }
}
