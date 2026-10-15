import { clipboard, Notification } from 'electron';
import type { PasteOutcomePayload, PasteTargetInfo } from '../../shared/helper-protocol';
import type { PasteResult } from '../../shared/state';
import type { HelperProcess } from '../helper/helper-process';
import { logger } from '../log';

// Pegado del texto, visto desde main. El trabajo lo hace el helper (guardar y
// restaurar el portapapeles, ⌘V, saber si llegó); aquí se le pide, se espera
// el resultado y, si no se pegó, se avisa una vez: el texto ya está en el
// portapapeles para pegarlo a mano. Si el helper no responde, el texto se
// escribe en el portapapeles desde main.

const log = logger('paste');

const CAPTURE_TIMEOUT_MS = 1_000;
/** El helper responde al enviar el ⌘V: hasta 1 s para traer la app y 1 s para que se suelten las teclas. */
const POST_TIMEOUT_MS = 4_000;
/** Tras el ⌘V, 1 s para que se pida el texto y medio más para comprobar el campo. */
const OUTCOME_TIMEOUT_MS = 6_000;

export interface PasteOutcome {
  result: PasteResult;
  appName: string | null;
  bundleId: string | null;
  /** Desde que main pidió el pegado hasta que una app pidió el texto. */
  requestedMs: number | null;
  /** Desde que main pidió el pegado hasta el ⌘V. */
  keystrokeMs: number | null;
  detail: string | null;
}

export interface PasteJob {
  /** Se resuelve al enviar el ⌘V (true) o al saber que no se enviará (false). */
  posted: Promise<boolean>;
  outcome: Promise<PasteOutcome>;
}

interface Waiting {
  text: string;
  resolve: (o: PasteOutcome) => void;
  timer: NodeJS.Timeout;
}

export class Paster {
  private waiting = new Map<string, Waiting>();
  /**
   * El último aviso. Hay que guardarlo: si el objeto se libera, Electron lo
   * quita del Centro de notificaciones, a veces antes de que llegue a verse.
   */
  private notice: Notification | null = null;

  constructor(private readonly helper: HelperProcess) {
    helper.on('event', (e) => {
      if (e.type === 'PasteOutcome') this.onOutcome(e.payload);
    });
    helper.on('state', (s) => {
      if (s.status === 'ready' || s.status === 'starting') return;
      for (const id of [...this.waiting.keys()]) this.fail(id, `helper ${s.status}`);
    });
  }

  /** Anota la app y el campo con foco con la clave `id`. null si no se pudo. */
  async captureTarget(id: string): Promise<PasteTargetInfo | null> {
    try {
      const res = await this.helper.request('CaptureTarget', { id }, CAPTURE_TIMEOUT_MS);
      const t = res.payload;
      return typeof t.pid === 'number' ? { pid: t.pid, appName: t.appName ?? null, bundleId: t.bundleId ?? null } : null;
    } catch (err) {
      log.warn(`Could not capture the paste target: ${(err as Error).message}`);
      return null;
    }
  }

  /** Pega `text` en la app anotada con `targetId` o, sin ella, donde esté el foco. */
  paste(id: string, text: string, targetId: string | null): PasteJob {
    const outcome = new Promise<PasteOutcome>((resolve) => {
      const timer = setTimeout(() => this.fail(id, 'no result from the helper'), OUTCOME_TIMEOUT_MS);
      this.waiting.set(id, { text, resolve, timer });
    });
    const posted = this.helper
      .request('PasteText', { pasteId: id, text, targetId }, POST_TIMEOUT_MS)
      .then((res) => res.payload.posted)
      .catch((err: Error) => {
        this.fail(id, err.message);
        return false;
      });
    return { posted, outcome };
  }

  /** Copia el texto al portapapeles, como si el usuario lo hubiera copiado. */
  copy(text: string): void {
    clipboard.writeText(text);
  }

  private onOutcome(p: PasteOutcomePayload): void {
    const w = this.waiting.get(p.pasteId);
    if (!w) return;
    const detail = p.verification ? `field ${p.verification}${p.earlyRead ? ', read before ⌘V' : ''}` : null;
    this.settle(p.pasteId, {
      result: p.result,
      appName: p.appName,
      bundleId: p.bundleId,
      requestedMs: p.requestedMs,
      keystrokeMs: p.keystrokeMs,
      detail,
    });
  }

  /** El helper no dio resultado: el texto se deja en el portapapeles desde aquí. */
  private fail(id: string, why: string): void {
    const w = this.waiting.get(id);
    if (!w) return;
    log.error(`Paste ${id.slice(0, 8)} failed: ${why}`);
    clipboard.writeText(w.text);
    this.settle(id, { result: 'failed', appName: null, bundleId: null, requestedMs: null, keystrokeMs: null, detail: why });
  }

  private settle(id: string, o: PasteOutcome): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    const notice = failureNotice(o);
    if (notice) this.notify(notice);
    w.resolve(o);
  }

  private notify(body: string): void {
    if (!Notification.isSupported()) return;
    this.notice?.close();
    this.notice = new Notification({ title: "Couldn't paste your dictation", body, silent: true });
    this.notice.show();
  }
}

/** Texto del aviso cuando el pegado no llegó; null si llegó. */
function failureNotice(o: PasteOutcome): string | null {
  const app = o.appName ?? 'The app';
  const tail = 'The text is on your clipboard: press ⌘V to paste it.';
  switch (o.result) {
    case 'pasted':
    case 'pasted_unverified':
    case 'pending':
    case 'empty':
      return null;
    case 'not_requested':
      return `${app} didn't take the text. Click in a text field first. ${tail}`;
    case 'unconfirmed':
      return `Speech couldn't confirm the text reached ${o.appName ?? 'the app'}. ${tail}`;
    case 'target_gone':
      return `${app} closed before the text was ready. ${tail}`;
    case 'focus_failed':
      return `Speech couldn't switch back to ${o.appName ?? 'the app'}. ${tail}`;
    case 'failed':
      return tail;
  }
}
