// Atajos de teclado. Las teclas son códigos virtuales de macOS (kVK_* de
// HIToolbox), más cuatro códigos propios para «⌘, ⇧, ⌥ o ⌃ de cualquier
// lado». Un atajo con una tecla normal (⌘⌃V) usa esos: se pulsa con
// cualquiera de los dos modificadores. Un atajo solo de modificadores conserva
// el lado (⌥ derecha sola), para que el otro siga escribiendo.

// ptt: mantener para dictar (doble toque: manos libres). hands_free: empieza
// o para un dictado en manos libres, y convierte en manos libres un ptt en curso.
export type ShortcutAction = 'ptt' | 'hands_free' | 'dismiss' | 'paste_last' | 'copy_last';

export const SHORTCUT_ACTIONS: ShortcutAction[] = ['ptt', 'hands_free', 'paste_last', 'copy_last', 'dismiss'];

export interface ShortcutBinding {
  action: ShortcutAction;
  keys: number[];
  /**
   * Cómo se llama cada tecla normal en la distribución de teclado con la que
   * se grabó (el código es la posición, no la letra). Sin nombre, el de la
   * distribución estadounidense.
   */
  names?: Record<string, string>;
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

/** «Cualquier lado» de cada modificador. Fuera del rango de los códigos reales. */
export const ANY_SIDE = {
  command: 0x1037,
  shift: 0x1038,
  option: 0x103a,
  control: 0x103b,
} as const;

/** Las dos teclas físicas que cubre cada código de «cualquier lado». */
export const SIDES: Record<number, [left: number, right: number]> = {
  [ANY_SIDE.command]: [0x37, 0x36],
  [ANY_SIDE.shift]: [0x38, 0x3c],
  [ANY_SIDE.option]: [0x3a, 0x3d],
  [ANY_SIDE.control]: [0x3b, 0x3e],
};

/** De tecla física a su código de «cualquier lado». */
const ANY_OF: Record<number, number> = Object.fromEntries(
  Object.entries(SIDES).flatMap(([any, pair]) => pair.map((k) => [k, Number(any)])),
);

export function anySide(key: number): number | null {
  return ANY_OF[key] ?? null;
}

export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { action: 'ptt', keys: [KEY.fn] },
  { action: 'hands_free', keys: [KEY.fn, KEY.space] },
  { action: 'dismiss', keys: [KEY.escape] },
  { action: 'paste_last', keys: [ANY_SIDE.control, ANY_SIDE.command, KEY.v] },
  { action: 'copy_last', keys: [ANY_SIDE.control, ANY_SIDE.command, KEY.c] },
];

/** ⌘, ⇧, ⌥, ⌃ (los dos lados) y fn. Bloq Mayús no cuenta. */
const MODIFIER_KEYS = new Set([0x36, 0x37, 0x38, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f]);

export function isModifier(key: number): boolean {
  return MODIFIER_KEYS.has(key) || key in SIDES;
}

/** ¿Esta tecla física cumple con esta tecla del atajo? */
export function keyMatches(bindingKey: number, physical: number): boolean {
  return bindingKey === physical || SIDES[bindingKey]?.includes(physical) === true;
}

/**
 * ¿Las teclas pulsadas son exactamente las del atajo? Cada tecla del atajo
 * necesita una pulsada que la cumpla, y no puede sobrar ninguna.
 */
export function comboMatches(keys: readonly number[], pressed: Iterable<number>): boolean {
  const list = [...pressed];
  if (list.length !== keys.length) return false;
  const used = new Set<number>();
  return keys.every((k) => {
    const p = list.find((x) => !used.has(x) && keyMatches(k, x));
    if (p === undefined) return false;
    used.add(p);
    return true;
  });
}

/** Las dos combinaciones se solapan: alguna pulsación cumpliría las dos. */
export function sameCombo(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const used = new Set<number>();
  return a.every((k) => {
    const i = b.findIndex((x, j) => !used.has(j) && (x === k || keyMatches(x, k) || keyMatches(k, x)));
    if (i < 0) return false;
    used.add(i);
    return true;
  });
}

/** Todas las teclas de `part` están en `whole` (contando lados). */
function containedIn(part: readonly number[], whole: readonly number[]): boolean {
  return part.every((k) => whole.some((x) => x === k || keyMatches(x, k) || keyMatches(k, x)));
}

/**
 * La entrada segura de otra app oculta al helper las teclas normales, pero no
 * los modificadores. Un atajo solo de modificadores (fn sola) sigue llegando;
 * cancelar y los del último dictado no cuentan porque no son imprescindibles.
 * Manos libres sigue al alcance con el doble toque del de dictar.
 */
const NON_ESSENTIAL: ReadonlySet<ShortcutAction> = new Set(['hands_free', 'dismiss', 'paste_last', 'copy_last']);

export function blockedBySecureInput(shortcuts: ShortcutBinding[]): boolean {
  return shortcuts.some((s) => !NON_ESSENTIAL.has(s.action) && s.keys.some((k) => !isModifier(k)));
}

// MARK: Edición

export const MAX_KEYS = 3;
/** Atajos por acción; cancelar tiene uno solo. */
export const MAX_PER_ACTION = 3;

/** Acciones que deben tener al menos un atajo. */
export const REQUIRED: ReadonlySet<ShortcutAction> = new Set(['ptt', 'dismiss']);

/**
 * Convierte lo pulsado al grabar en las teclas del atajo: con una tecla
 * normal, los modificadores valen por cualquier lado; solo modificadores,
 * cada uno con su lado.
 */
export function recordedKeys(pressed: readonly number[]): number[] {
  const hasNormal = pressed.some((k) => !isModifier(k));
  const keys = hasNormal ? pressed.map((k) => anySide(k) ?? k) : [...pressed];
  return [...new Set(keys)].sort((a, b) => sortRank(a) - sortRank(b));
}

/** Orden de las pastillas: fn, ⌃, ⌥, ⇧, ⌘ y luego la tecla. */
function sortRank(key: number): number {
  const base = SIDES[key]?.[0] ?? key;
  const order = [0x3f, 0x3b, 0x3e, 0x3a, 0x3d, 0x38, 0x3c, 0x37, 0x36];
  const i = order.indexOf(base);
  return i >= 0 ? i * 2 + (key in SIDES ? 0 : 1) : 100 + key;
}

/** Combinaciones que el sistema o casi cualquier app ya usan. */
const BLOCKED: number[][] = [
  [ANY_SIDE.command, 0x08], // ⌘C
  [ANY_SIDE.command, 0x09], // ⌘V
  [ANY_SIDE.command, 0x07], // ⌘X
  [ANY_SIDE.command, 0x06], // ⌘Z
  [ANY_SIDE.command, 0x00], // ⌘A
  [ANY_SIDE.command, 0x0c], // ⌘Q
  [ANY_SIDE.command, 0x0d], // ⌘W
  [ANY_SIDE.command, 0x30], // ⌘Tab
  [ANY_SIDE.command, KEY.space], // Spotlight
  [ANY_SIDE.control, KEY.space], // cambiar de fuente de entrada
];

export type ShortcutCheck =
  | { ok: true; warning?: string }
  | { ok: false; error: string };

/**
 * Valida un atajo nuevo para `action` frente a los demás. `replacing` es el
 * índice (en `all`) del que sustituye, si edita uno existente.
 */
export function checkShortcut(
  action: ShortcutAction,
  keys: readonly number[],
  all: readonly ShortcutBinding[],
  replacing: number | null,
  names?: Record<string, string>,
): ShortcutCheck {
  if (keys.length === 0) return { ok: false, error: 'Press at least one key' };
  if (keys.length > MAX_KEYS) return { ok: false, error: `Shortcut must contain ${MAX_KEYS} or fewer keys` };
  const families = keys.map((k) => anySide(k) ?? k);
  if (new Set(families).size !== families.length) {
    return { ok: false, error: 'Shortcut cannot contain both left and right version of the same key' };
  }
  const normal = keys.filter((k) => !isModifier(k));
  // Cancelar puede ser una tecla sola (Esc); el resto, no: se comería esa tecla al escribir.
  if (action !== 'dismiss' && normal.length > 0 && normal.length === keys.length) {
    return { ok: false, error: 'Shortcut must include a modifier key' };
  }
  if (normal.length > 1) return { ok: false, error: 'Shortcut can have only one key besides modifiers' };
  // ⇧ con una letra escribiría una mayúscula: no vale como único modificador.
  if (normal.length === 1 && keys.length > 1 && keys.every((k) => !isModifier(k) || anySide(k) === ANY_SIDE.shift || k === ANY_SIDE.shift)) {
    return { ok: false, error: `This shortcut is not allowed: ${comboLabel(keys, names)}` };
  }
  if (BLOCKED.some((b) => sameCombo(b, keys))) {
    return { ok: false, error: `This shortcut is not allowed: ${comboLabel(keys, names)}` };
  }
  const others = all.filter((_, i) => i !== replacing);
  if (others.some((b) => sameCombo(b.keys, keys))) return { ok: false, error: 'This shortcut is already in use' };
  // Un atajo de manos libres contenido en uno de dictar los confunde.
  const ptt = others.filter((b) => b.action === 'ptt').map((b) => b.keys);
  const hands = others.filter((b) => b.action === 'hands_free').map((b) => b.keys);
  const overlap =
    (action === 'hands_free' && ptt.some((p) => containedIn(keys, p))) ||
    (action === 'ptt' && hands.some((h) => containedIn(h, keys)));
  if (overlap) {
    return {
      ok: true,
      warning: 'Warning: Your Hands-free mode shortcut is a part of a Push-to-talk shortcut. This may lead to conflicts.',
    };
  }
  return { ok: true };
}

/** Validación de la lista guardada en las preferencias. */
export function isShortcutList(value: unknown): value is ShortcutBinding[] {
  if (!Array.isArray(value)) return false;
  const valid = value.every(
    (b) =>
      b &&
      typeof b === 'object' &&
      (SHORTCUT_ACTIONS as unknown[]).includes((b as ShortcutBinding).action) &&
      Array.isArray((b as ShortcutBinding).keys) &&
      (b as ShortcutBinding).keys.length > 0 &&
      (b as ShortcutBinding).keys.length <= MAX_KEYS &&
      (b as ShortcutBinding).keys.every((k) => Number.isInteger(k) && k >= 0 && k < 0x2000) &&
      ((b as ShortcutBinding).names === undefined || isNameMap((b as ShortcutBinding).names)),
  );
  if (!valid) return false;
  const list = value as ShortcutBinding[];
  return [...REQUIRED].every((a) => list.some((b) => b.action === a));
}

function isNameMap(v: unknown): boolean {
  return !!v && typeof v === 'object' && Object.values(v).every((s) => typeof s === 'string' && s.length <= 8);
}

// MARK: Nombres

const MODIFIER_LABELS: Record<number, string> = {
  0x3f: 'fn',
  [ANY_SIDE.command]: '⌘ Cmd',
  [ANY_SIDE.shift]: '⇧ Shift',
  [ANY_SIDE.option]: '⌥ Opt',
  [ANY_SIDE.control]: '⌃ Ctrl',
  0x37: 'Left ⌘',
  0x36: 'Right ⌘',
  0x38: 'Left ⇧',
  0x3c: 'Right ⇧',
  0x3a: 'Left ⌥',
  0x3d: 'Right ⌥',
  0x3b: 'Left ⌃',
  0x3e: 'Right ⌃',
};

/** Teclas sin letra: igual en cualquier distribución. */
const SPECIAL_LABELS: Record<number, string> = {
  0x31: 'Space',
  0x35: 'esc',
  0x24: 'Return',
  0x4c: 'Enter',
  0x30: 'Tab',
  0x33: 'Delete',
  0x75: 'Fwd Del',
  0x7b: '←',
  0x7c: '→',
  0x7d: '↓',
  0x7e: '↑',
  0x73: 'Home',
  0x77: 'End',
  0x74: 'Page Up',
  0x79: 'Page Down',
  0x39: 'Caps Lock',
  0x7a: 'F1',
  0x78: 'F2',
  0x63: 'F3',
  0x76: 'F4',
  0x60: 'F5',
  0x61: 'F6',
  0x62: 'F7',
  0x64: 'F8',
  0x65: 'F9',
  0x6d: 'F10',
  0x67: 'F11',
  0x6f: 'F12',
  0x69: 'F13',
  0x6b: 'F14',
  0x71: 'F15',
  0x6a: 'F16',
  0x40: 'F17',
  0x4f: 'F18',
  0x50: 'F19',
  0x5a: 'F20',
};

/** Distribución estadounidense, para las teclas sin nombre grabado. */
const ANSI_LABELS: Record<number, string> = {
  0x00: 'a', 0x0b: 'b', 0x08: 'c', 0x02: 'd', 0x0e: 'e', 0x03: 'f', 0x05: 'g', 0x04: 'h', 0x22: 'i',
  0x26: 'j', 0x28: 'k', 0x25: 'l', 0x2e: 'm', 0x2d: 'n', 0x1f: 'o', 0x23: 'p', 0x0c: 'q', 0x0f: 'r',
  0x01: 's', 0x11: 't', 0x20: 'u', 0x09: 'v', 0x0d: 'w', 0x07: 'x', 0x10: 'y', 0x06: 'z',
  0x12: '1', 0x13: '2', 0x14: '3', 0x15: '4', 0x17: '5', 0x16: '6', 0x1a: '7', 0x1c: '8', 0x19: '9', 0x1d: '0',
  0x1b: '-', 0x18: '=', 0x21: '[', 0x1e: ']', 0x2a: '\\', 0x29: ';', 0x27: "'", 0x2b: ',', 0x2f: '.', 0x2c: '/', 0x32: '`',
};

export function keyLabel(key: number, names?: Record<string, string>): string {
  return MODIFIER_LABELS[key] ?? SPECIAL_LABELS[key] ?? names?.[String(key)] ?? ANSI_LABELS[key] ?? `Key ${key}`;
}

/** Con espacios: «⌃ Ctrl ⌘ Cmd v». */
export function comboLabel(keys: readonly number[], names?: Record<string, string>): string {
  return keys.map((k) => keyLabel(k, names)).join(' ');
}

/** Para los textos: «fn», «⌃⌘V», «Right ⌥». */
export function compactLabel(keys: readonly number[], names?: Record<string, string>): string {
  const symbol = (k: number): string => {
    const any = { [ANY_SIDE.command]: '⌘', [ANY_SIDE.shift]: '⇧', [ANY_SIDE.option]: '⌥', [ANY_SIDE.control]: '⌃' }[k];
    if (any) return any;
    const label = keyLabel(k, names);
    return label.length === 1 ? label.toUpperCase() : label;
  };
  const parts = keys.map(symbol);
  // Los símbolos van pegados; las palabras, con espacio.
  return parts.reduce((out, p, i) => (i === 0 ? p : /^[⌘⇧⌥⌃]$/.test(parts[i - 1]) && p.length <= 1 ? out + p : `${out} ${p}`), '');
}

/** El primer atajo de una acción, o null. */
export function firstBinding(list: readonly ShortcutBinding[], action: ShortcutAction): ShortcutBinding | null {
  return list.find((b) => b.action === action) ?? null;
}

/**
 * Acelerador de Electron para el menú de la barra (solo para enseñarlo), o
 * undefined si el atajo no se puede escribir así.
 */
export function accelerator(b: ShortcutBinding | null): string | undefined {
  if (!b) return undefined;
  const mods: Record<number, string> = {
    [ANY_SIDE.command]: 'Command',
    [ANY_SIDE.control]: 'Control',
    [ANY_SIDE.option]: 'Alt',
    [ANY_SIDE.shift]: 'Shift',
  };
  const parts: string[] = [];
  for (const k of b.keys) {
    if (mods[k]) parts.push(mods[k]);
    else if (isModifier(k)) return undefined;
    else {
      const label = keyLabel(k, b.names);
      if (label === 'Space') parts.push('Space');
      else if (label === 'esc') parts.push('Escape');
      else if (/^F\d+$/.test(label) || /^[a-z0-9]$/i.test(label)) parts.push(label.toUpperCase());
      else return undefined;
    }
  }
  return parts.join('+');
}
