import { Check } from "lucide-react";

import { cn } from "@shared/lib/cn";

interface CheckboxProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

/**
 * Square check control used by the Components and Choose-data steps.
 * Accent fill when checked; disabled+checked is how a required item
 * reads (always on, not togglable).
 */
export function Checkbox({ checked, onChange, label, disabled }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        "focus-ring grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] border transition-colors",
        checked
          ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-ink)]"
          : "border-[var(--hairline-strong)] bg-[var(--color-overlay-1)] text-transparent",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      )}
    >
      <Check size={13} strokeWidth={3} />
    </button>
  );
}
