import { useEffect, useState } from 'react';
import type { SharedState } from '../shared/state';

/** Copia local del estado de main; se actualiza con cada cambio. */
export function useSharedState(): SharedState | null {
  const [state, setState] = useState<SharedState | null>(null);
  useEffect(() => {
    let alive = true;
    // Suscribirse antes de pedir el estado para no perder un cambio intermedio.
    const off = window.speech.onState((s) => alive && setState(s));
    void window.speech.getState().then((s) => alive && setState((prev) => prev ?? s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return state;
}
