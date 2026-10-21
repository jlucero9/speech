import type { BarSound, Notice, NoticeStatus } from '../../shared/bar';
import { logger } from '../log';
import type { Store } from '../store';

// Avisos de la barra. Hay uno como mucho: el nuevo sustituye al anterior.
// La barra cuenta el tiempo (se para con el cursor encima) y avisa cuando se
// cierra. Al aparecer suena según su estado, si los sonidos están activados.

const log = logger('notices');

/** Lo que pide quien avisa; lo demás tiene valor por defecto. */
export type NewNotice = Pick<Notice, 'kind' | 'title'> &
  Partial<Omit<Notice, 'id' | 'kind' | 'title'>> & {
    /** false: aparece sin sonido. */
    sound?: boolean;
  };

/** Si nadie dice otra cosa, un aviso dura esto. */
const DEFAULT_TIMEOUT_MS = 4_000;

const SOUND_FOR: Record<NoticeStatus, BarSound> = { info: 'notice', alert: 'alert', error: 'error' };

export class Notices {
  private nextId = 1;

  constructor(
    private readonly store: Store,
    private readonly play: (sound: BarSound) => void,
  ) {}

  get current(): Notice | null {
    return this.store.get().bar.notice;
  }

  show(n: NewNotice): Notice {
    const { sound, ...rest } = n;
    const notice: Notice = {
      status: 'info',
      badge: null,
      body: null,
      actions: [],
      timeoutMs: DEFAULT_TIMEOUT_MS,
      dictationId: null,
      ...rest,
      id: this.nextId++,
    };
    this.set(notice);
    log.info(`Notice ${notice.id} (${notice.kind}): ${notice.title.replace(/\*\*/g, '')}`);
    if (sound !== false) this.play(SOUND_FOR[notice.status]);
    return notice;
  }

  /** Cierra el aviso `id` si sigue siendo el que se ve. */
  close(id: number, why: string): void {
    if (this.current?.id !== id) return;
    log.info(`Notice ${id} closed (${why})`);
    this.set(null);
  }

  /** Cierra el aviso que se ve si es de alguno de estos tipos. */
  clear(...kinds: string[]): void {
    const c = this.current;
    if (c && kinds.includes(c.kind)) this.close(c.id, 'replaced by state');
  }

  private set(notice: Notice | null): void {
    this.store.update((s) => ({ ...s, bar: { ...s.bar, notice } }));
  }
}
