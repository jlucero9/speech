// Protocolo entre main y el helper Swift (helper/Sources/SpeechHelper/IPC.swift).
//
// Transporte:
//   main → helper: stdin del helper.
//   helper → main: descriptor 3 del helper. stdout y stderr son solo registro.
// Formato: un objeto JSON por línea (JSON escapa los saltos de línea dentro de
// las cadenas, así que el salto de línea es un separador seguro).
//
//   petición  {"kind":"request","id":"<uuid>","type":"IsReady","payload":{}}
//   respuesta {"kind":"response","id":"<uuid de la petición>","type":"ACK","payload":{...}}
//   error     {"kind":"response","id":"<uuid>","type":"Error","payload":{"message":"..."}}
//   evento    {"kind":"event","type":"AccessibilityStatusChanged","payload":{...}}
//
// Cualquier mensaje de main cuenta como latido para el helper: si pasan 15 s
// sin ninguno, el helper se cierra solo.
//
// Pegado: al empezar un dictado main pide `CaptureTarget` (el helper anota la
// app y el campo con foco); al terminar, `PasteText` con la misma clave. La
// respuesta llega al enviar el ⌘V (o al saber que no se enviará) y el
// resultado después, en el evento `PasteOutcome`.
//
// Teclado: el helper no envía todas las teclas. Envía las de los atajos y,
// mientras una de ellas está pulsada, las que la acompañan; del resto solo
// cuenta cuántas hay pulsadas (`hidden`). Main interpreta los atajos. Mientras
// se graba un atajo en el Hub (`SetShortcutRecording`), envía todas, con su
// nombre en la distribución de teclado, y se traga las que no son modificadores.

import type { ShortcutBinding } from './shortcuts';

export const HELPER_PROTOCOL_VERSION = 6;

/** Tope de una línea; algo más largo es un fallo del otro lado. */
export const HELPER_MAX_LINE_BYTES = 1024 * 1024;

export interface HelperRequests {
  /** «Listo» = el helper responde. No implica permisos. */
  IsReady: {
    payload: Record<string, never>;
    response: {
      type: 'ACK';
      payload: {
        pid: number;
        protocolVersion: number;
        launchMs: number;
        disclaimed: boolean;
        tap: HelperTapState;
        memoryPressure: MemoryPressureLevel;
      };
    };
  };
  GetAccessibilityStatus: {
    payload: Record<string, never>;
    response: { type: 'AccessibilityStatus'; payload: { trusted: boolean } };
  };
  /** Muestra el diálogo del sistema si no hay permiso. */
  RequestAccessibilityPermission: {
    payload: Record<string, never>;
    response: { type: 'AccessibilityStatus'; payload: { trusted: boolean } };
  };
  /** Los atajos vigentes: el helper los usa para filtrar y para saber qué teclas tragarse. */
  UpdateShortcuts: {
    payload: { shortcuts: ShortcutBinding[] };
    response: { type: 'OK'; payload: Record<string, never> };
  };
  /** Grabación de un atajo: todas las teclas a main y ninguna a las apps. Se apaga sola al minuto. */
  SetShortcutRecording: {
    payload: { on: boolean };
    response: { type: 'OK'; payload: Record<string, never> };
  };
  /**
   * Silencia la salida de audio (o le devuelve el sonido). Solo devuelve el
   * sonido que quitó el propio helper; si ya estaba silenciada, no la toca.
   */
  SetOutputMuted: {
    payload: { muted: boolean };
    response: { type: 'OutputMute'; payload: { changed: boolean; detail: string } };
  };
  /** Con un dictado en marcha, el helper se traga la tecla de cancelar. */
  SetDictationActive: {
    payload: { active: boolean };
    response: { type: 'OK'; payload: Record<string, never> };
  };
  /** Devuelve las teclas de la lista que en realidad ya no están pulsadas. */
  CheckStaleKeys: {
    payload: { keys: number[] };
    response: { type: 'StaleKeys'; payload: { released: number[] } };
  };
  GetKeyboardStatus: {
    payload: Record<string, never>;
    response: { type: 'KeyboardStatus'; payload: KeyboardStatusPayload };
  };
  /** Muestra el diálogo de Monitorización de entrada si no hay permiso. */
  RequestInputMonitoring: {
    payload: Record<string, never>;
    response: { type: 'InputMonitoringStatus'; payload: { granted: boolean } };
  };
  /**
   * Anota con la clave `id` la app de delante y su elemento con foco, y lee el
   * texto alrededor del cursor (salvo `readContext: false`). Vacío si no hay app.
   */
  CaptureTarget: {
    payload: { id: string; readContext: boolean };
    response: { type: 'Target'; payload: Partial<PasteTargetInfo> & { context?: TargetContextPayload } };
  };
  /**
   * Pega `text` en la app anotada con `targetId` (o donde esté el foco).
   * `posted: false`: no se envió el ⌘V; el motivo llega en `PasteOutcome`.
   */
  PasteText: {
    payload: { pasteId: string; text: string; targetId?: string | null };
    response: { type: 'PasteStarted'; payload: { posted: boolean } };
  };
}

export interface PasteTargetInfo {
  pid: number;
  appName: string | null;
  bundleId: string | null;
  /** Texto alrededor del cursor (hasta 1 000 caracteres por lado); null si no se pudo leer. */
  surroundings: { before: string; after: string; selected: string } | null;
  /** Por qué no se leyó el texto, si no se leyó. */
  surroundingsUnavailable: string | null;
}

/** Texto alrededor del cursor según el helper, o el motivo por el que no se leyó. */
export type TargetContextPayload =
  | { before: string; after: string; selected: string; role: string }
  | { unavailable: string };

/**
 * Resultado de un pegado según el helper. Solo los dos primeros restauran el
 * portapapeles; en los demás el texto queda en él para pegarlo a mano.
 */
export type HelperPasteResult =
  | 'pasted' // una app pidió el texto y está en el campo con foco
  | 'pasted_unverified' // una app pidió el texto; el campo no deja leer su contenido
  | 'unconfirmed' // alguien pidió el texto, pero no consta que llegara al campo
  | 'not_requested' // nadie pidió el texto en 1 s
  | 'target_gone' // la app de destino se cerró
  | 'focus_failed'; // la app de destino no volvió a ponerse delante

export interface PasteOutcomePayload {
  pasteId: string;
  result: HelperPasteResult;
  /** Desde que el helper recibió PasteText hasta el ⌘V. */
  keystrokeMs: number | null;
  /** Desde que el helper recibió PasteText hasta que una app pidió el texto. */
  requestedMs: number | null;
  /** Qué se vio en el campo con foco tras pegar. */
  verification: 'found' | 'not_found' | 'not_editable' | 'unavailable' | null;
  /** El texto se pidió antes del ⌘V: lo leyó otro proceso. */
  earlyRead: boolean;
  appName: string | null;
  bundleId: string | null;
}

export type HelperTapState = 'active' | 'no-permission' | 'failed' | 'stopped';

/** Presión de memoria del sistema, según el kernel. */
export type MemoryPressureLevel = 'normal' | 'warning' | 'critical';

export interface SecureInputPayload {
  blocked: boolean;
  pid?: number;
  appName?: string | null;
  bundleId?: string | null;
  /** Hora (ms) desde la que está activa. */
  since?: number | null;
}

/** Valor de «Pulsar la tecla 🌐 para» en Ajustes del Sistema › Teclado. */
export type FnUsage = 'nothing' | 'input-source' | 'emoji' | 'dictation' | 'unknown';

export interface KeyboardStatusPayload {
  tap: HelperTapState;
  reason: string;
  /** Permiso de Monitorización de entrada (CGPreflightListenEventAccess). */
  listenAccess: boolean;
  secureInput: SecureInputPayload;
  fnUsage: FnUsage;
}

export type HelperRequestType = keyof HelperRequests;

export interface HelperEvents {
  AccessibilityStatusChanged: { trusted: boolean };
  /** `index` es correlativo desde 1 en cada arranque del helper. */
  KeyEvent: { index: number; key: number; down: boolean; hidden: number; name?: string };
  /** `reason: 'storm'` con `state: 'failed'`: el helper va a salir para que main lo relance. */
  TapStatus: { state: HelperTapState; reason: string; listenAccess: boolean };
  SecureInputStatus: SecureInputPayload;
  PasteOutcome: PasteOutcomePayload;
  MemoryPressure: { level: MemoryPressureLevel };
}

export type HelperRequestMessage = {
  kind: 'request';
  id: string;
  type: HelperRequestType;
  payload: unknown;
};

export type HelperResponseMessage = {
  kind: 'response';
  id: string;
  type: string;
  payload: unknown;
};

export type HelperEventMessage = {
  [K in keyof HelperEvents]: { kind: 'event'; type: K; payload: HelperEvents[K] };
}[keyof HelperEvents];

export type HelperIncoming = HelperResponseMessage | HelperEventMessage;
