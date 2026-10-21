// Atajos de teclado. Las teclas son códigos virtuales de macOS
// (kVK_* de HIToolbox). Hasta que exista el editor de atajos, valen los de
// por defecto.

// ptt: mantener para dictar (doble toque: manos libres). hands_free: empieza
// o para un dictado en manos libres, y convierte en manos libres un ptt en curso.
export type ShortcutAction = 'ptt' | 'hands_free' | 'dismiss' | 'paste_last' | 'copy_last';

export interface ShortcutBinding {
  action: ShortcutAction;
  keys: number[];
}

export const KEY = {
  fn: 0x3f,
  escape: 0x35,
  space: 0x31,
  command: 0x37,
  control: 0x3b,
  c: 0x08,
  v: 0x09,
} as const;

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { action: 'ptt', keys: [KEY.fn] },
  { action: 'hands_free', keys: [KEY.fn, KEY.space] },
  { action: 'dismiss', keys: [KEY.escape] },
  { action: 'paste_last', keys: [KEY.command, KEY.control, KEY.v] },
  { action: 'copy_last', keys: [KEY.command, KEY.control, KEY.c] },
];

/**
 * Los que no hacen falta para dictar: que la entrada segura los bloquee no
 * merece aviso. Manos libres sigue al alcance con el doble toque de fn.
 */
const NON_ESSENTIAL: ReadonlySet<ShortcutAction> = new Set(['hands_free', 'dismiss', 'paste_last', 'copy_last']);

/** ⌘, ⇧, ⌥, ⌃ (los dos lados) y fn. Bloq Mayús no cuenta. */
const MODIFIER_KEYS = new Set([0x36, 0x37, 0x38, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]);

/**
 * La entrada segura de otra app oculta al helper las teclas normales, pero no
 * los modificadores. Un atajo solo de modificadores (fn sola) sigue llegando;
 * cancelar y los del último dictado no cuentan porque no son imprescindibles.
 */
export function blockedBySecureInput(shortcuts: ShortcutBinding[]): boolean {
  return shortcuts.some((s) => !NON_ESSENTIAL.has(s.action) && s.keys.some((k) => !MODIFIER_KEYS.has(k)));
}
