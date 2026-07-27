import { beginRegionCapture } from "@services/tauri/clients/overlay";
import { cn } from "@shared/lib/cn";

import { CHROME_STOP_PROPS } from "../eventStops";
import { captureFullscreenFromOverlay } from "../hooks/fullscreenCapture";
import { SIDEBAR_ITEMS } from "../modes";
import { useOverlayStore } from "../state/overlayStore";

/**
 * Left-rail capture-type switcher (Region / Window / Fullscreen /
 * Custom) with R/W/F/C shortcuts. Region + Window swap the overlay mode
 * in place; Fullscreen captures the monitor under the cursor straight
 * out of the cached snapshot; Custom renders disabled (its modes are
 * entered from the capture window).
 *
 * Shown only while the overlay is in Region or Window mode — the other
 * (reserved) overlay modes skip this sidebar entirely.
 *
 * NOTE: not currently mounted by `OverlayLayout` — the in-overlay
 * switch ships via the W/R/F keybinds for now. Kept mode-correct so
 * mounting it later is a one-liner.
 */
export function CaptureTypeSidebar() {
  const mode = useOverlayStore((s) => s.mode);
  const reset = useOverlayStore((s) => s.reset);
  if (mode !== "region" && mode !== "window") return null;

  const onPick = async (id: (typeof SIDEBAR_ITEMS)[number]["id"]) => {
    if (id === mode) return; // already in this mode
    if (id === "region" || id === "window") {
      // Swap overlay mode in place: re-opening re-snapshots the desktop
      // and (for Window) re-enumerates. The OVERLAY_OPENING event resets
      // overlay state + sets the new mode; the window-list hook refetches.
      reset();
      await beginRegionCapture(id);
      return;
    }
    if (id === "fullscreen") {
      // Captures the monitor under the cursor out of the cached
      // snapshot — no bounce back to the capture window.
      captureFullscreenFromOverlay();
    }
    // C is disabled (deferred port); the click is a visual no-op via
    // `enabled: false` + opacity below.
  };

  return (
    <div
      {...CHROME_STOP_PROPS}
      className="absolute left-7 top-1/2 -translate-y-1/2 z-20"
    >
      <div className="flex w-[180px] flex-col gap-1 rounded-2xl border border-[color:var(--hairline)] bg-[var(--color-surface)] p-2 shadow-[var(--shadow-deep)] backdrop-blur-md">
        {SIDEBAR_ITEMS.map((it) => {
          const Icon = it.icon;
          const active = it.id === mode;
          return (
            <button
              key={it.id}
              type="button"
              onClick={() => void onPick(it.id)}
              disabled={!it.enabled}
              title={!it.enabled ? "Coming soon" : it.label}
              aria-pressed={active}
              className={cn(
                "relative flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-[13px] font-medium transition-colors",
                active
                  ? "bg-[color:var(--color-accent-soft)] text-[var(--color-accent)]"
                  : "text-[var(--color-slate)] hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]",
                !it.enabled && "cursor-not-allowed opacity-55"
              )}
            >
              {active && (
                <span className="absolute left-0 h-5 w-[3px] rounded-full bg-[var(--color-accent)]" />
              )}
              <Icon size={18} strokeWidth={1.75} />
              <span className="flex-1">{it.label}</span>
              <span
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide",
                  active
                    ? "bg-[color:var(--color-accent)]/15 text-[var(--color-accent)]"
                    : "bg-[color:var(--color-overlay-2)] text-[var(--color-hint)]"
                )}
              >
                {it.shortcut}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
