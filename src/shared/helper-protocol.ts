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

export const HELPER_PROTOCOL_VERSION = 1;

/** Tope de una línea; algo más largo es un fallo del otro lado. */
export const HELPER_MAX_LINE_BYTES = 1024 * 1024;

export interface HelperRequests {
  /** «Listo» = el helper responde. No implica permisos. */
  IsReady: {
    payload: Record<string, never>;
    response: { type: 'ACK'; payload: { pid: number; protocolVersion: number; launchMs: number; disclaimed: boolean } };
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
}

export type HelperRequestType = keyof HelperRequests;

export interface HelperEvents {
  AccessibilityStatusChanged: { trusted: boolean };
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
