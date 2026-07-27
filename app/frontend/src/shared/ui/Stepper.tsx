import { cn } from "@shared/lib/cn";

interface StepperProps {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  /** Accessible label for the number field + the ± buttons. */
  label: string;
}

/**
 * Minus / number / plus integer stepper — the shared control behind the
 * capture-delay and palette-swatch steppers in both the capture window
 * and the settings panel. Clamps to `min..max`. Plus/minus buttons fire
 * `preventDefault()` so a surrounding row's hover/focus state doesn't
 * steal focus on click.
 */
export function Stepper({
  value,
  onChange,
  disabled = false,
  min = 0,
  max = 100,
  label,
}: StepperProps) {
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
        aria-label={`Decrease ${label}`}
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
        aria-label={label}
        className="focus-ring w-8 bg-transparent text-center font-mono text-[12px] font-medium text-[var(--color-ink)] outline-none [appearance:textfield] disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />

      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          set(value + 1);
        }}
        disabled={disabled || value >= max}
        aria-label={`Increase ${label}`}
        className="focus-ring grid h-6 w-6 place-items-center text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        +
      </button>
    </span>
  );
}
