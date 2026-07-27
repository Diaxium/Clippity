import { cn } from "@shared/lib/cn";

interface SwatchCountStepperProps {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
}

/**
 * Minus / number / plus integer stepper for the Palette-Capture swatch
 * count. Same shape as `DelayStepper` but with count-appropriate labels
 * and a 2..16 range (the backend's `palette::{MIN,MAX}_PALETTE_COUNT`).
 * Plus/minus buttons `preventDefault` so the surrounding row's hover
 * state doesn't steal focus.
 */
export function SwatchCountStepper({
  value,
  onChange,
  disabled = false,
  min = 2,
  max = 16,
}: SwatchCountStepperProps) {
  const set = (n: number) => onChange(Math.max(min, Math.min(max, n)));

  return (
    <span
      className={cn(
        "inline-flex items-center overflow-hidden rounded-md border border-[color:var(--hairline)] bg-[var(--color-surface)]",
        disabled && "opacity-55"
      )}
    >
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          set(value - 1);
        }}
        disabled={disabled || value <= min}
        aria-label="Fewer swatches"
        className="focus-ring grid h-6 w-6 place-items-center text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        −
      </button>

      <input
        type="number"
        value={value}
        onChange={(e) => {
          const v = parseInt(e.currentTarget.value, 10);
          if (!Number.isNaN(v)) set(v);
        }}
        onClick={(e) => e.preventDefault()}
        disabled={disabled}
        min={min}
        max={max}
        aria-label="Number of palette swatches"
        className="focus-ring w-7 bg-transparent text-center font-mono text-[12px] font-medium text-[var(--color-ink)] outline-none [appearance:textfield] disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />

      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          set(value + 1);
        }}
        disabled={disabled || value >= max}
        aria-label="More swatches"
        className="focus-ring grid h-6 w-6 place-items-center text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        +
      </button>
    </span>
  );
}
