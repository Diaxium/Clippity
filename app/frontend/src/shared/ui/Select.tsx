import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@shared/lib/cn";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Class applied to the trigger button — accepts size, padding, fill. */
  triggerClassName?: string;
  disabled?: boolean;
  /**
   * Render `placeholder` in the trigger instead of the option matching `value`
   * — for a multi-selection whose members disagree. The list still opens and
   * picking an option commits normally, which is how the choice is unified.
   */
  placeholder?: string;
}

/**
 * Minimal custom dropdown. Click trigger → list of options below.
 *
 * Accessibility note: this is a lightweight implementation for MVP —
 * keyboard ArrowUp/ArrowDown navigation, Enter to commit, Escape to
 * close, outside-click to close. It does not implement the full
 * WAI-ARIA listbox pattern. When richer keyboard/screen-reader
 * support is needed, swap implementation behind this same prop
 * surface.
 */
/** Matches the list's `max-h-60` (240px) plus its 4px offset — used to
 *  decide whether the menu still fits below the trigger. */
const MENU_MAX_PX = 244;

export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  triggerClassName,
  disabled = false,
  placeholder,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedLabel =
    placeholder ?? options.find((o) => o.value === value)?.label ?? value;

  // The list renders in-flow (no portal), so a trigger near the window
  // bottom used to spill the menu past the viewport edge where it got
  // clipped to its first option. Measure on open and flip upward when
  // below-space can't fit the menu but above-space can.
  const place = () => {
    const r = containerRef.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const fitNeeded = Math.min(
      MENU_MAX_PX,
      // Approximate list height: ~30px per option + list padding.
      options.length * 30 + 12
    );
    setOpenUp(below < fitNeeded && r.top > below);
  };
  const toggleOpen = () => {
    if (disabled) return;
    if (!open) place();
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onTriggerKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        place();
        setOpen(true);
        return;
      }
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const idx = options.findIndex((o) => o.value === value);
      const next = Math.max(0, Math.min(options.length - 1, idx + dir));
      const nextOption = options[next];
      if (nextOption) onChange(nextOption.value);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggleOpen}
        onKeyDown={onTriggerKey}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn(
          "focus-ring inline-flex w-full items-center justify-between gap-2 text-[13px] font-medium text-[var(--color-ink)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          triggerClassName ??
            "h-9 rounded-md border border-[color:var(--hairline)] bg-[var(--color-surface)] px-3"
        )}
      >
        <span
          className={cn("truncate", placeholder && "text-[var(--color-hint)]")}
        >
          {selectedLabel}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.85}
          className="shrink-0 text-[var(--color-hint)]"
        />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={ariaLabel}
          className={cn(
            "clippity-menu absolute left-0 right-0 z-30 max-h-60 overflow-y-auto rounded-md border border-[color:var(--hairline-strong)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-elevated)]",
            openUp ? "bottom-[calc(100%+4px)]" : "top-[calc(100%+4px)]"
          )}
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "focus-ring flex w-full items-center px-3 py-1.5 text-left text-[13px] transition-colors",
                    active
                      ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
                      : "text-[var(--color-ink)] hover:bg-[color:var(--color-overlay-1)]"
                  )}
                >
                  {opt.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
