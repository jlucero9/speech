import type { FormattingState } from '../../shared/formatting';
import type { ModelState } from '../../shared/transcription';
import type { NewNotice } from './notices';

// Textos de los avisos de la barra, en un solo sitio. Los atajos van en
// **negrita**.

/** Atajos que nombran los avisos, como se escriben en macOS; cambian con los ajustes. */
const keys = { ptt: 'fn', pasteLast: '⌃⌘V' as string | null };

export function setNoticeShortcuts(ptt: string, pasteLast: string | null): void {
  keys.ptt = ptt;
  keys.pasteLast = pasteLast;
}

const n = (v: number): string => v.toLocaleString('en-US');

export const notice = {
  pasteFailed(dictationId: string | null): NewNotice {
    return {
      kind: 'paste_failed',
      status: 'info',
      badge: 'Tip',
      title: keys.pasteLast
        ? `Click a textbox and use **${keys.pasteLast}** to paste`
        : 'Click a textbox and paste it with **⌘V**',
      timeoutMs: 6_000,
      dictationId,
    };
  },

  /** Se pegó la transcripción sin formatear; `result` es el `format_result` del historial. */
  formatFallback(result: string, formatting: FormattingState, dictationId: string): NewNotice {
    const local = formatting.provider === 'ollama';
    let body: string;
    switch (result) {
      case 'raw_not_ready':
        body = local
          ? formatting.status === 'no_model'
            ? `The formatting model isn't installed. ${formatting.detail ?? ''}`.trim()
            : "Ollama isn't running. Start it and your next dictation will be formatted."
          : (formatting.detail ?? "The formatting service isn't available.");
        break;
      case 'raw_timeout':
        body = local
          ? 'Formatting took too long, probably while the model was loading. The next dictation should be faster.'
          : 'The formatting service took too long to answer.';
        break;
      case 'raw_rejected':
        body = 'The formatted version changed your words too much, so your transcript was pasted as you said it.';
        break;
      case 'raw_network':
        body = "Couldn't reach the formatting service.";
        break;
      case 'raw_auth':
        body = 'The formatting service rejected your API key.';
        break;
      case 'raw_quota':
        body = "You've reached the formatting service's usage limit.";
        break;
      case 'raw_low_memory':
        body = 'Your Mac is low on memory, so cleanup was skipped. It comes back on its own when memory frees up.';
        break;
      default:
        body = 'The formatter returned an error.';
    }
    const actionable = result === 'raw_not_ready' || result === 'raw_auth';
    return {
      kind: 'format_fallback',
      status: 'alert',
      title: 'Pasted without formatting',
      body,
      actions: actionable ? [{ action: 'open_engines', label: 'Open Speech' }] : [],
      timeoutMs: 6_000,
      dictationId,
    };
  },

  cancelled(dictationId: string): NewNotice {
    return {
      kind: 'cancelled',
      status: 'alert',
      title: 'You can recover your cancelled transcript',
      body: 'We noticed you cancelled your transcription',
      actions: [
        { action: 'undo_cancel', label: 'Undo' },
        { action: 'open_history', label: 'Open History' },
      ],
      timeoutMs: 8_000,
      dictationId,
    };
  },

  nothingToRecover(): NewNotice {
    return {
      kind: 'nothing_to_recover',
      status: 'info',
      title: 'There is nothing to recover',
      body: 'The cancelled dictation was too short to keep.',
    };
  },

  shortTap(): NewNotice {
    return {
      kind: 'short_tap',
      status: 'info',
      badge: 'Tip',
      title: `Hold **${keys.ptt}** while you speak, or double-tap it for hands-free`,
      timeoutMs: 3_000,
      sound: false,
    };
  },

  busy(): NewNotice {
    return {
      kind: 'busy',
      status: 'info',
      title: 'Still working on your last dictation',
      timeoutMs: 2_500,
      sound: false,
    };
  },

  helperNotReady(): NewNotice {
    return {
      kind: 'helper_not_ready',
      status: 'error',
      title: "Speech isn't ready to dictate",
      body: 'Its keyboard and paste helper is not running. Open Speech to restart it.',
      actions: [{ action: 'open_hub', label: 'Open Speech' }],
      timeoutMs: 8_000,
    };
  },

  microphonePermission(): NewNotice {
    return {
      kind: 'microphone_permission',
      status: 'error',
      title: "Speech can't use your microphone",
      body: 'Allow it in System Settings › Privacy & Security › Microphone.',
      actions: [{ action: 'open_microphone_settings', label: 'Open Settings' }],
      timeoutMs: 8_000,
    };
  },

  modelNotReady(model: ModelState): NewNotice {
    const downloading = model.status === 'downloading' || model.status === 'verifying';
    const pct = model.totalBytes ? Math.floor((model.receivedBytes / model.totalBytes) * 100) : 0;
    return {
      kind: 'model_not_ready',
      status: 'error',
      title: "The speech model isn't ready yet",
      body: downloading
        ? `It's still downloading (${pct}%). You can dictate as soon as it finishes.`
        : 'Open Speech to download it. After that, dictation works offline.',
      actions: downloading ? [] : [{ action: 'open_hub', label: 'Open Speech' }],
      timeoutMs: 8_000,
    };
  },

  micSilent(dictationId: string): NewNotice {
    return {
      kind: 'mic_silent',
      status: 'alert',
      title: "Your microphone isn't picking up any sound",
      body: "Check that it's connected and not muted.",
      timeoutMs: 6_000,
      dictationId,
    };
  },

  recordingFailed(message: string, dictationId: string): NewNotice {
    return {
      kind: 'recording_failed',
      status: 'error',
      title: "Couldn't record your dictation",
      body: message,
      timeoutMs: 8_000,
      dictationId,
    };
  },

  transcriptionFailed(message: string, dictationId: string): NewNotice {
    return {
      kind: 'transcription_failed',
      status: 'error',
      title: "Couldn't transcribe your dictation",
      body: message,
      actions: [{ action: 'open_history', label: 'Open History' }],
      timeoutMs: 8_000,
      dictationId,
    };
  },

  noSpeech(dictationId: string): NewNotice {
    return {
      kind: 'no_speech',
      status: 'info',
      title: "We didn't hear anything",
      body: 'Nothing was pasted. Speak a little closer to the microphone.',
      timeoutMs: 4_000,
      dictationId,
    };
  },

  microphoneLost(): NewNotice {
    return {
      kind: 'microphone_lost',
      status: 'alert',
      title: 'Your microphone was disconnected',
      body: 'What you said until then is being transcribed.',
      timeoutMs: 6_000,
    };
  },

  sleepStopped(dictationId: string): NewNotice {
    return {
      kind: 'sleep_stopped',
      status: 'alert',
      title: 'Your Mac went to sleep while you were dictating',
      body: 'Your recording is saved. Recover it to transcribe and paste it.',
      actions: [
        { action: 'undo_cancel', label: 'Recover' },
        { action: 'open_history', label: 'Open History' },
      ],
      timeoutMs: 12_000,
      dictationId,
    };
  },

  durationWarning(): NewNotice {
    return { kind: 'duration_warning', status: 'info', title: 'Dictation will stop after one more minute', timeoutMs: 6_000 };
  },

  maxDuration(): NewNotice {
    return {
      kind: 'max_duration',
      status: 'info',
      title: 'Dictation stopped after 20 minutes',
      body: 'What you said is being transcribed.',
      timeoutMs: 6_000,
    };
  },

  databaseRepaired(recovered: number, unreadable: number): NewNotice {
    return {
      kind: 'database_repaired',
      status: 'alert',
      title: 'Speech repaired your history',
      body:
        unreadable > 0 || recovered === 0
          ? `Its file was damaged. ${n(recovered)} items were recovered${unreadable ? ` and ${n(unreadable)} could not be read` : ''}. A copy of the damaged file was kept.`
          : `Its file was damaged. All ${n(recovered)} items were recovered, and a copy of the damaged file was kept.`,
      actions: [{ action: 'open_history', label: 'Open History' }],
      timeoutMs: 12_000,
    };
  },

  databaseDamaged(): NewNotice {
    return {
      kind: 'database_damaged',
      status: 'error',
      title: 'Your history file is damaged',
      body: 'Dictation keeps working. Restart Speech to repair it; nothing is deleted.',
      actions: [{ action: 'restart_app', label: 'Restart' }],
      timeoutMs: 0,
    };
  },

  barHidden(): NewNotice {
    return {
      kind: 'bar_hidden',
      status: 'info',
      title: 'The bar will be hidden for an hour',
      body: 'It still appears while you dictate.',
      actions: [{ action: 'show_bar', label: 'Undo' }],
      timeoutMs: 6_000,
      sound: false,
    };
  },
};
