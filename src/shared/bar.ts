// Barra flotante: dónde se ancla y los avisos que muestra. Main decide qué
// aviso hay; la barra solo lo pinta, cuenta su tiempo y avisa al cerrarse.

export type BarEdge = 'bottom' | 'left' | 'right';

export function isBarEdge(value: unknown): value is BarEdge {
  return value === 'bottom' || value === 'left' || value === 'right';
}

/** 'info' lleva distintivo (o nada); 'alert' y 'error', su icono junto al título. */
export type NoticeStatus = 'info' | 'alert' | 'error';

export type NoticeAction =
  | 'undo_cancel' // vuelve a transcribir el audio de un dictado cancelado
  | 'open_hub'
  | 'open_microphone_settings'
  | 'show_bar'; // deshace «ocultar una hora»

export interface Notice {
  /** Creciente: un aviso nuevo con el mismo tipo se distingue del anterior. */
  id: number;
  kind: string;
  status: NoticeStatus;
  /** Texto del distintivo de un aviso 'info' («Tip»); null, sin distintivo. */
  badge: string | null;
  /** Admite **negrita** para atajos de teclado. */
  title: string;
  body: string | null;
  actions: { action: NoticeAction; label: string }[];
  /** Cuenta atrás hasta cerrarse solo; se para con el cursor encima. 0: no se cierra solo. */
  timeoutMs: number;
  /** Dictado al que se refiere, si alguno. */
  dictationId: string | null;
}

export interface BarState {
  notice: Notice | null;
}

/** Sonidos de la barra. Los de aviso dependen del estado del aviso. */
export type BarSound = 'start' | 'stop' | 'lock' | 'notice' | 'alert' | 'error';
