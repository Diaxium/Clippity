import { cn } from "@shared/lib/cn";

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}

/**
 * iOS-style switch. Receives its label via `aria-label` (the visible
 * label lives in the option-row layout, not the switch itself).
 */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={cn(
        "focus-ring relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked
          ? "bg-[var(--color-accent)]"
          : "bg-[color:var(--color-overlay-3)]"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-[16px] w-[16px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.18)] transition-transform",
          checked && "translate-x-[16px]"
        )}
      />
    </button>
  );
}
