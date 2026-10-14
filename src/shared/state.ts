// Estado compartido: main es la única fuente de verdad y cada ventana recibe
// una copia completa en cada cambio (es pequeño). Las ventanas no lo modifican
// directamente: piden acciones por IPC (ver ipc.ts).

import type { Preferences } from './preferences';

export type HelperStatus =
  | 'starting' // proceso lanzado, esperando el primer ACK
  | 'ready' // responde a IsReady
  | 'restarting' // murió o dejó de responder; relanzado programado
  | 'failed' // agotó los reintentos; solo se relanza a mano
  | 'stopped'; // la app se está cerrando

export interface HelperState {
  status: HelperStatus;
  pid: number | null;
  /** Relanzamientos desde el último periodo estable. */
  restarts: number;
  /** Hora (ms) del próximo intento si status es 'restarting'. */
  nextAttemptAt: number | null;
  lastError: string | null;
}

/** 'unknown' mientras el helper no ha contestado. */
export type AccessibilityPermission = 'granted' | 'denied' | 'unknown';

/** Valores de systemPreferences.getMediaAccessStatus de Electron. */
export type MicrophonePermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export interface DataState {
  databaseReady: boolean;
  schemaVersion: number;
  /** Migraciones aplicadas en este arranque (0 si la base ya estaba al día). */
  migrationsAppliedThisLaunch: number;
  error: string | null;
}

export interface SharedState {
  helper: HelperState;
  permissions: {
    accessibility: AccessibilityPermission;
    microphone: MicrophonePermission;
  };
  data: DataState;
  prefs: Preferences;
}
