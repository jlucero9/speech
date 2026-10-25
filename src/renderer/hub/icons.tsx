// Iconos del Hub, dibujados a mano (trazo en una cuadrícula de 24).

import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

function Svg({ size = 20, strokeWidth = 1.75, className, children }: IconProps & { children: ReactNode }) {
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

export function MicIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M18.5 10.5v.5a6.5 6.5 0 0 1-13 0v-.5" />
      <path d="M12 17.5v4" />
    </Svg>
  );
}

export function BookIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 19V5a2.5 2.5 0 0 1 2.5-2.5H19v15H7.5A2.5 2.5 0 0 0 5 20a1.5 1.5 0 0 0 1.5 1.5H19" />
      <path d="M9 7h6" />
    </Svg>
  );
}

export function GearIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.4 2.5h3.2l.5 2.6a7.5 7.5 0 0 1 1.9 1.1l2.5-.9 1.6 2.8-2 1.7a7.6 7.6 0 0 1 0 2.4l2 1.7-1.6 2.8-2.5-.9a7.5 7.5 0 0 1-1.9 1.1l-.5 2.6h-3.2l-.5-2.6a7.5 7.5 0 0 1-1.9-1.1l-2.5.9-1.6-2.8 2-1.7a7.6 7.6 0 0 1 0-2.4l-2-1.7 1.6-2.8 2.5.9a7.5 7.5 0 0 1 1.9-1.1z" />
      <circle cx="12" cy="12" r="2.75" />
    </Svg>
  );
}

export function SidebarIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </Svg>
  );
}

export function PlayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 4.5v15a.8.8 0 0 0 1.2.7l12-7.5a.8.8 0 0 0 0-1.4l-12-7.5A.8.8 0 0 0 7 4.5z" />
    </Svg>
  );
}

export function PauseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="6" y="4.5" width="4" height="15" rx="1" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" />
    </Svg>
  );
}

export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="8.5" y="8.5" width="13" height="13" rx="2" />
      <path d="M15.5 8.5V5a2 2 0 0 0-2-2h-8.5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h3.5" />
    </Svg>
  );
}

export function FlagIcon({ filled, ...p }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...p}>
      <path d="M5 21.5V4" />
      <path d="M5 4.5c1.2-.9 2.6-1.3 4-1.3 3 0 4 2 7 2 1.4 0 2.4-.3 3.5-.9v10.4c-1.1.6-2.1.9-3.5.9-3 0-4-2-7-2-1.4 0-2.8.4-4 1.3" fill={filled ? 'currentColor' : 'none'} />
    </Svg>
  );
}

export function MoreIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="5" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="19" r="1" fill="currentColor" />
    </Svg>
  );
}

export function UndoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
  );
}

export function RedoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </Svg>
  );
}

export function RetryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8.5" />
      <path d="M20.5 3.5v5h-5" />
    </Svg>
  );
}

export function TrashIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 6h17" />
      <path d="M18.5 6v13.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V6" />
      <path d="M8.5 6V4.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V6" />
      <path d="M10 11v6M14 11v6" />
    </Svg>
  );
}

export function AudioFileIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z" />
      <path d="M14 2.5V8h5.5" />
      <path d="M8.5 15v-1.5M11 17.5v-6M13.5 16v-3M16 15v-1" />
    </Svg>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="10.5" cy="10.5" r="7" />
      <path d="m20.5 20.5-5-5" />
    </Svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  );
}

export function AlertIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7.5v5" />
      <path d="M12 16.5h.01" />
    </Svg>
  );
}

export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4.5 1.5L5 15z" />
      <path d="m14.5 5.5 3 3" />
    </Svg>
  );
}

export function StarIcon({ filled, ...p }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...p}>
      <path
        d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9l-5.4 2.9 1.1-6.1-4.5-4.3 6.1-.8z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Svg>
  );
}

export function SortIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m3.5 8 4-4.5 4 4.5M7.5 4v16" />
      <path d="m20.5 16-4 4.5-4-4.5M16.5 20V4" />
    </Svg>
  );
}

export function ImportIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v12" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4 15.5v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function SelectIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12 3 3 5-6" />
    </Svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}

export function ArrowRightIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4.5 12h15M13.5 6l6 6-6 6" />
    </Svg>
  );
}

export function InfoIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.5h.01" />
    </Svg>
  );
}

/** Marca de la app: tres barras de onda dentro de un círculo. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="12" fill="currentColor" />
      <path d="M8 10v4M12 7v10M16 9.5v5" stroke="var(--background)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
