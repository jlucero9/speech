import type { SharedState } from '../../shared/state';

// Círculo que se rellena con el porcentaje gastado del plan gratuito de Groq.
// Sin tokens ni segundos: solo cuánto queda, de 0 a 100.

/** Avisa en ámbar a partir de aquí. */
const WARN_PERCENT = 80;

export function UsageRing({ percent, size = 18, stroke = 2.5 }: { percent: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, percent));
  const tone = p >= 100 ? 'usage-ring-full' : p >= WARN_PERCENT ? 'usage-ring-warn' : '';
  return (
    <svg className={`usage-ring ${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="usage-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
      <circle
        className="usage-ring-fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - p / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/** Groq hace algo en el dictado con las preferencias actuales. */
export function usesGroq(state: SharedState): boolean {
  const p = state.prefs;
  return p.transcriptionEngine === 'groq' || (p.smartFormatting && p.formattingProvider === 'groq');
}

/** Frase para el tooltip y la descripción. */
export function groqUsageText(state: SharedState): string {
  const u = state.cloudUsage.groq;
  if (u.limitedUntil && u.limitedUntil > Date.now()) {
    const at = new Date(u.limitedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `You've used all of Groq's free allowance. It's available again at ${at}.`;
  }
  return `${u.percent}% of Groq's free daily allowance used in the last 24 hours.`;
}
