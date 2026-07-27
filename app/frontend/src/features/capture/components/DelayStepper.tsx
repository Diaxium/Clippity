import { cn } from "@shared/lib/cn";

interface DelayStepperProps {
  value: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
}

/**
 * Minus / number / plus integer stepper for the capture-delay seconds
 * row. Clamps to `min..max` (default 1..60). Plus/minus buttons fire
 * `e.preventDefault()` to keep the surrounding row's hover state from
 * stealing focus.
 */
export function DelayStepper({
  value,
  onChange,
  disabled = false,
  min = 1,
  max = 60,
}: DelayStepperProps) {
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
        aria-label="Decrease delay"
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
        aria-label="Delay in seconds"
        className="focus-ring w-7 bg-transparent text-center font-mono text-[12px] font-medium text-[var(--color-ink)] outline-none [appearance:textfield] disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />

      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          set(value + 1);
        }}
        disabled={disabled || value >= max}
        aria-label="Increase delay"
        className="focus-ring grid h-6 w-6 place-items-center text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-2)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        +
      </button>
    </span>
  );
}
