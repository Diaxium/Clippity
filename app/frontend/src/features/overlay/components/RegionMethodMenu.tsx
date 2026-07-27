import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { setOverlayMode } from "@services/tauri/clients/overlay";
import { cn } from "@shared/lib/cn";

import { REGION_METHODS, type RegionMethod } from "../modes";
import { useOverlayStore } from "../state/overlayStore";

/**
 * The unified Region control: a split/caret button that shows the active
 * selection method and opens a popover to switch between Rectangle,
 * Freehand, Pen / Bézier, Magnetic Lasso, and Brush.
 *
 * Switching is in-place — all methods crop the same cached desktop
 * snapshot, so picking one clears the current selection (without dropping
 * the snapshot), flips the local overlay mode, and tells the backend so
 * the saved file is labelled after the method drawn. No re-snapshot, no
 * flicker.
 */
export function RegionMethodMenu() {
  const mode = useOverlayStore((s) => s.mode);
  const setMode = useOverlayStore((s) => s.setMode);
  const clearSelection = useOverlayStore((s) => s.clearSelection);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Dismiss on outside pointer / Escape — but let Escape still cancel the
  // overlay when the menu is closed (handled by useOverlayKeybinds).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const active =
    REGION_METHODS.find((m) => m.id === mode) ?? REGION_METHODS[0]!;
  const ActiveIcon = active.icon;

  const pick = (m: RegionMethod) => {
    setOpen(false);
    if (!m.available || m.id === mode) return;
    clearSelection();
    setMode(m.id);
    void setOverlayMode(m.id);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Selection method"
        className={cn(
          "relative inline-flex items-center gap-1.5 rounded-[9px] px-2 py-1 text-[11.5px] font-medium",
          "text-[var(--color-ink)] transition-colors duration-150",
          "hover:bg-[color:var(--color-overlay-1)]"
        )}
      >
        <ActiveIcon size={12} strokeWidth={1.85} />
        <span>{active.label}</span>
        <ChevronDown
          size={11}
          strokeWidth={2}
          className={cn(
            "text-[var(--color-slate)] transition-transform duration-150",
            open && "rotate-180"
          )}
        />
        <span className="ovl-tab-indicator" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-2 w-[230px] overflow-hidden rounded-[12px] border border-[color:var(--hairline)] bg-[var(--color-surface)] p-1 shadow-[var(--shadow-deep)] backdrop-blur-md"
        >
          {REGION_METHODS.map((m) => {
            const Icon = m.icon;
            const isActive = m.id === mode;
            return (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                disabled={!m.available}
                onClick={() => pick(m)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left transition-colors",
                  isActive
                    ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
                    : "text-[var(--color-ink)] hover:bg-[color:var(--color-overlay-1)]",
                  !m.available && "cursor-not-allowed opacity-45"
                )}
              >
                <Icon size={15} strokeWidth={1.75} className="shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[12px] font-medium leading-tight">
                    {m.label}
                    {!m.available && (
                      <span className="ml-1 text-[10px] text-[var(--color-hint)]">
                        soon
                      </span>
                    )}
                  </span>
                  <span className="text-[10.5px] leading-tight text-[var(--color-hint)]">
                    {m.hint}
                  </span>
                </span>
                {isActive && (
                  <Check
                    size={13}
                    strokeWidth={2.2}
                    className="ml-auto shrink-0"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
