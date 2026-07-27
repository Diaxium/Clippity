import type { LucideIcon } from "lucide-react";
import { Clipboard, MousePointer2, Timer } from "lucide-react";

import { cn } from "@shared/lib/cn";

import { TIMED_CHOICES, type TrayToggleKey } from "../hooks/useTrayPanel";

interface CaptureControlsProps {
  cursor: boolean;
  clipboard: boolean;
  timed: boolean;
  onToggle: (key: TrayToggleKey, value: boolean) => void;
  timedSeconds: number;
  onTimedSecondsChange: (seconds: number) => void;
}

interface ToggleChipProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}

/** A small pill that fills with the accent tint when its option is on. */
function ToggleChip({ icon: Icon, label, active, onClick }: ToggleChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`${label}: ${active ? "on" : "off"}`}
      className={cn(
        "focus-ring no-drag inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11.5px] font-medium transition-colors",
        active
          ? "border-[color:var(--color-accent)]/40 bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
          : "border-[color:var(--hairline)] text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
      )}
    >
      <Icon size={13} strokeWidth={2} />
      {label}
    </button>
  );
}

/**
 * Quick-capture modifiers beneath the capture tiles: Cursor, Copy, and
 * Timed toggles. All three apply to every quick capture — Cursor + Copy
 * via `emitOverlayToggles` (the Region / Window overlay) and the immediate
 * Fullscreen grab; Timed arms the countdown delay. The seconds selector
 * only appears once Timed is on, so the row stays compact when it isn't.
 */
export function CaptureControls({
  cursor,
  clipboard,
  timed,
  onToggle,
  timedSeconds,
  onTimedSecondsChange,
}: CaptureControlsProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <ToggleChip
          icon={MousePointer2}
          label="Cursor"
          active={cursor}
          onClick={() => onToggle("cursor", !cursor)}
        />
        <ToggleChip
          icon={Clipboard}
          label="Copy"
          active={clipboard}
          onClick={() => onToggle("clipboard", !clipboard)}
        />
        <ToggleChip
          icon={Timer}
          label="Timed"
          active={timed}
          onClick={() => onToggle("timed", !timed)}
        />
      </div>

      {timed && (
        <div
          role="group"
          aria-label="Timed capture delay"
          className="flex items-center gap-1"
        >
          {TIMED_CHOICES.map((s) => {
            const active = s === timedSeconds;
            return (
              <button
                key={s}
                type="button"
                onClick={() => onTimedSecondsChange(s)}
                aria-pressed={active}
                title={`Timed delay: ${s} seconds`}
                className={cn(
                  "focus-ring no-drag min-w-[26px] rounded-md px-1.5 py-1 text-[11.5px] font-semibold transition-colors",
                  active
                    ? "bg-[color:var(--color-accent)] text-[var(--color-accent-ink)]"
                    : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
                )}
              >
                {s}s
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
