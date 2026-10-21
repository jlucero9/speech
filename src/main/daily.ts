// Tareas diarias a una hora fija (hora local).

/**
 * Llama a `run` cada día a la hora `hour`:00. Un temporizador largo se
 * retrasa mientras el equipo duerme, así que se vuelve a mirar cada hora y al
 * despertar (`onResume`); si la hora pasó durmiendo, se hace al despertar.
 */
export function scheduleDaily(
  hour: number,
  onResume: (check: () => void) => void,
  run: () => void,
  now: () => number = Date.now,
): () => void {
  let due = nextAt(hour, now());
  let timer: NodeJS.Timeout | null = null;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, Math.max(0, Math.min(due - now(), 60 * 60_000)));
  };
  const check = (): void => {
    if (now() >= due) {
      due = nextAt(hour, now());
      run();
    }
    arm();
  };
  onResume(check);
  arm();
  return () => {
    if (timer) clearTimeout(timer);
  };
}

/** La próxima vez que el reloj marque `hour`:00, estrictamente después de `now`. */
export function nextAt(hour: number, now: number): number {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
