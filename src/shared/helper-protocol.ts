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
// Teclado: el helper no envía todas las teclas. Envía las de los atajos y,
// mientras una de ellas está pulsada, las que la acompañan; del resto solo
// cuenta cuántas hay pulsadas (`hidden`). Main interpreta los atajos.

import type { ShortcutBinding } from './shortcuts';

export const HELPER_PROTOCOL_VERSION = 2;

/** Tope de una línea; algo más largo es un fallo del otro lado. */
export const HELPER_MAX_LINE_BYTES = 1024 * 1024;

export interface HelperRequests {
  /** «Listo» = el helper responde. No implica permisos. */
  IsReady: {
    payload: Record<string, never>;
    response: {
      type: 'ACK';
      payload: { pid: number; protocolVersion: number; launchMs: number; disclaimed: boolean; tap: HelperTapState };
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
}

export type HelperTapState = 'active' | 'no-permission' | 'failed' | 'stopped';

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
  KeyEvent: { index: number; key: number; down: boolean; hidden: number };
  /** `reason: 'storm'` con `state: 'failed'`: el helper va a salir para que main lo relance. */
  TapStatus: { state: HelperTapState; reason: string; listenAccess: boolean };
  SecureInputStatus: SecureInputPayload;
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
