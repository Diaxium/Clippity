import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";

import type { ScrollDirection } from "@services/tauri/clients/scroll";
import { cn } from "@shared/lib/cn";

interface ScrollDirectionPickerProps {
  value: ScrollDirection;
  onChange: (next: ScrollDirection) => void;
  /** Smaller variant for tight chrome (the overlay toolbar). */
  compact?: boolean;
  disabled?: boolean;
}

const DIRECTIONS: ReadonlyArray<{
  value: ScrollDirection;
  label: string;
  icon: typeof ArrowDown;
}> = [
  { value: "down", label: "Scroll down", icon: ArrowDown },
  { value: "up", label: "Scroll up", icon: ArrowUp },
  { value: "left", label: "Scroll left", icon: ArrowLeft },
  { value: "right", label: "Scroll right", icon: ArrowRight },
];

/**
 * Four-way scroll-direction selector (Down / Up / Left / Right) for the
 * Scrolling-Window + Panoramic capture modes. Down is the default (read
 * a long page top-to-bottom). Used in both the capture options panel and
 * the overlay toolbar, so it's a shared control.
 */
export function ScrollDirectionPicker({
  value,
  onChange,
  compact = false,
  disabled = false,
}: ScrollDirectionPickerProps) {
  const box = compact ? "h-7 w-7" : "h-8 w-8";
  const iconSize = compact ? 13 : 15;

  return (
    <div
      role="radiogroup"
      aria-label="Scroll direction"
      className="inline-flex items-center gap-1 rounded-[10px] bg-[color:var(--color-overlay-1)] p-1"
    >
      {DIRECTIONS.map(({ value: dir, label, icon: Icon }) => {
        const active = value === dir;
        return (
          <button
            key={dir}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            disabled={disabled}
            onClick={() => onChange(dir)}
            className={cn(
              "focus-ring grid place-items-center rounded-[7px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              box,
              active
                ? "bg-[var(--color-accent)] text-[var(--color-accent-ink)] shadow-[var(--shadow-subtle)]"
                : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)]"
            )}
          >
            <Icon size={iconSize} strokeWidth={2} />
          </button>
        );
      })}
    </div>
  );
}
