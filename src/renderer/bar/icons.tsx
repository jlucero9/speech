// Iconos de la barra, dibujados a mano (trazo de 2 en una cuadrícula de 24).

interface IconProps {
  size: number;
  className?: string;
  strokeWidth?: number;
}

function Svg({ size, className, strokeWidth = 2, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function MicIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="8.5" y="2" width="7" height="13" rx="3.5" fill="currentColor" stroke="none" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21.5" />
    </Svg>
  );
}

export function InfoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </Svg>
  );
}

export function AlertIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.3 3.9L2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4M12 17v.1" />
    </Svg>
  );
}

export function ErrorIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7.5v5.5M12 16.4v.1" />
    </Svg>
  );
}

// Iconos del menú contextual (trazo fino, como en los menús del Hub).

export function ClockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 1.5M5 3.5 2.5 6M19 3.5 21.5 6" />
    </Svg>
  );
}

export function GearIcon(p: IconProps) {
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return `M${(12 + 6.5 * c).toFixed(2)} ${(12 + 6.5 * s).toFixed(2)}L${(12 + 9 * c).toFixed(2)} ${(12 + 9 * s).toFixed(2)}`;
  }).join('');
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d={spokes} />
    </Svg>
  );
}

export function MicOutlineIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21.5" />
    </Svg>
  );
}

export function HistoryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5" y="4" width="14" height="17.5" rx="2" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
      <path d="M8.5 11h7M8.5 15h5" />
    </Svg>
  );
}

export function PasteIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 4h2a2 2 0 0 1 2 2v13.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="9" y="2.5" width="6" height="3.5" rx="1" />
      <path d="M12 10v7.5M9 14.5l3 3 3-3" />
    </Svg>
  );
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 6l6 6-6 6" />
    </Svg>
  );
}
