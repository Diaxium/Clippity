import { cn } from "@shared/lib/cn";

import {
  DURATION_MAX_MS,
  DURATION_MIN_MS,
  DURATION_STEP_MS,
} from "../constants";

interface DurationSliderProps {
  value: number;
  onChange(next: number): void;
  /** When false, the visible label gets a subtle "Reserved" cue but the
   *  slider still works so the value persists for the day the owning
   *  port lands. */
  armed?: boolean;
}

/**
 * 0..15000 ms slider in 500 ms steps. `0` is the "Sticky" semantic.
 * The legacy used the same envelope; matching it means the user's
 * mental model carries over.
 */
export function DurationSlider({
  value,
  onChange,
  armed = true,
}: DurationSliderProps) {
  return (
    <span className="inline-flex items-center gap-3">
      <input
        type="range"
        min={DURATION_MIN_MS}
        max={DURATION_MAX_MS}
        step={DURATION_STEP_MS}
        value={value}
        onChange={(e) => onChange(parseInt(e.currentTarget.value, 10))}
        className={cn(
          "clippity-slider h-1 w-[160px] cursor-pointer appearance-none rounded-full bg-[color:var(--color-overlay-2)]",
          !armed && "opacity-60"
        )}
        aria-label="Auto-dismiss duration"
      />
      <span className="w-14 text-right font-mono text-[12px] text-[var(--color-ink)]">
        {value === 0 ? "Sticky" : `${(value / 1000).toFixed(1)}s`}
      </span>
    </span>
  );
}
