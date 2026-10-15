// Atajos de teclado. Las teclas son códigos virtuales de macOS
// (kVK_* de HIToolbox). Hasta que exista el editor de atajos, valen los de
// por defecto.

export type ShortcutAction = 'ptt' | 'dismiss';

export interface ShortcutBinding {
  action: ShortcutAction;
  keys: number[];
}

export const KEY = {
  fn: 0x3f,
  escape: 0x35,
} as const;

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { action: 'ptt', keys: [KEY.fn] },
  { action: 'dismiss', keys: [KEY.escape] },
];

/** ⌘, ⇧, ⌥, ⌃ (los dos lados) y fn. Bloq Mayús no cuenta. */
const MODIFIER_KEYS = new Set([0x36, 0x37, 0x38, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]);

/**
 * La entrada segura de otra app oculta al helper las teclas normales, pero no
 * los modificadores. Un atajo solo de modificadores (fn sola) sigue llegando;
 * cancelar no cuenta porque no es imprescindible.
 */
export function blockedBySecureInput(shortcuts: ShortcutBinding[]): boolean {
  return shortcuts.some((s) => s.action !== 'dismiss' && s.keys.some((k) => !MODIFIER_KEYS.has(k)));
}
