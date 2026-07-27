import { useEffect } from "react";

import {
  beginRegionCapture,
  cancelRegionCapture,
} from "@services/tauri/clients/overlay";

import { finishRegionCapture } from "@services/tauri/clients/overlay";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { clampToViewport } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";
import type { OverlayMode } from "../types";
import { captureFullscreenFromOverlay } from "./fullscreenCapture";
import { captureWindow, recordWindow } from "./useWindowSelection";
import { useOverlayFinalize } from "./useOverlayFinalize";

const TEXT_INPUT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const ARROW_NUDGE = 1;
const ARROW_NUDGE_BIG = 10;

/** Modes whose selection IS a single axis-aligned rect, and can
 *  therefore accept a restored last region. Mirrors `isRegionLike` in
 *  `OverlayLayout`. Multi-Area is excluded: its rects live in `areas`,
 *  not `rect`, so restoring into it would need a `commitArea`. */
const RECT_MODES = new Set<OverlayMode>([
  "region",
  "palette",
  "grab-text",
  "scrolling",
  "panoramic",
]);

/**
 * Window-level keyboard handlers for the overlay:
 *
 * - `Esc` → `cancel_region_capture`
 * - `Enter` → finalize: the hovered window (Window mode) or the current
 *   Region / Freehand / Multi-Area selection via `useOverlayFinalize`
 * - `Backspace` → Multi-Area: drop the last committed rect
 * - `?` / `F1` → toggle KeybindHelp
 * - `R` / `W` → swap to Region / Window mode in place (no-op if already)
 * - `F` → capture the monitor under the cursor, straight from the
 *   cached snapshot
 * - `C` → no-op (the custom modes are entered from the capture window)
 *
 * Suppressed when the active element is a text input (none exist in
 * the overlay today, but cheap defensive guard).
 */
export function useOverlayKeybinds() {
  const helpOpen = useOverlayStore((s) => s.helpOpen);
  const setHelpOpen = useOverlayStore((s) => s.setHelpOpen);
  const reset = useOverlayStore((s) => s.reset);
  const { finalize } = useOverlayFinalize();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Help toggle works regardless of which other key the user hit.
      if (e.key === "?" || e.key === "F1") {
        e.preventDefault();
        setHelpOpen(!helpOpen);
        return;
      }
      // When help is open it owns its own Esc — don't double-fire.
      if (helpOpen) return;

      const tag = document.activeElement?.tagName ?? "";
      if (TEXT_INPUT_TAGS.has(tag)) return;

      if (e.key === "Escape") {
        e.preventDefault();
        reset();
        void cancelRegionCapture();
        return;
      }

      if (e.key === "Enter") {
        const s = useOverlayStore.getState();
        if (s.mode === "window" || s.mode === "record-window") {
          // Window mode: Enter captures the currently-hovered window,
          // mirroring a click. No-op over bare desktop.
          const hovered = s.windows.find((w) => w.id === s.hoveredWindowId);
          if (!hovered) return;
          e.preventDefault();
          if (s.mode === "record-window") {
            // No flash — the commit starts a recording rather than
            // taking a shot (see `recordWindow`).
            recordWindow(hovered, s.recordFormat, () => reset());
            return;
          }
          s.fireCaptureFlash();
          captureWindow(hovered, s.toggles, () => reset());
          return;
        }
        if (s.mode === "object") {
          // Object mode: Enter captures the currently-hovered detection,
          // mirroring a click. No-op over bare desktop. A detection rect
          // is already physical px, so it goes straight to finalize.
          const obj =
            s.hoveredObjectIndex === null
              ? undefined
              : s.objects[s.hoveredObjectIndex];
          if (!obj) return;
          e.preventDefault();
          s.fireCaptureFlash();
          finishRegionCapture({
            rect: obj.rect,
            cursorPin: null,
            toggles: s.toggles,
          })
            .then(() => reset())
            .catch((err: unknown) => {
              const message =
                err instanceof Error ? err.message : "Capture failed.";
              void emitErrorToast(message);
            });
          return;
        }
        // Pen: while still drawing, Enter closes the path (→ selected)
        // rather than finalizing. Once closed it finalizes like the rest.
        if (s.mode === "pen" && s.phase !== "selected") {
          e.preventDefault();
          s.closePen();
          return;
        }
        // Region / Freehand / Pen / Magnetic-Lasso / Multi-Area finalize
        // through the shared mode-aware hook (a no-op when nothing is
        // selected yet). The hook fires the capture flash + resets on
        // success.
        e.preventDefault();
        finalize();
        return;
      }

      if (e.key === "Backspace") {
        const s = useOverlayStore.getState();
        // Multi-Area: drop the most recently committed rect.
        if (s.mode === "multi-area" && s.areas.length > 0) {
          e.preventDefault();
          s.popArea();
        } else if (s.mode === "pen" && s.penPath.length > 0) {
          // Pen: remove the last-placed anchor.
          e.preventDefault();
          s.popPenAnchor();
        }
        return;
      }

      // Arrow keys nudge the committed selection (1 px, or 10 px with
      // Shift) — accessibility precision adjustment without grabbing
      // a handle. Alt+Arrow resizes the rect from its bottom-right
      // corner instead of moving it.
      if (
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight"
      ) {
        const s = useOverlayStore.getState();
        if (s.phase !== "selected" || !s.rect) return;
        e.preventDefault();
        const step = e.shiftKey ? ARROW_NUDGE_BIG : ARROW_NUDGE;
        const dx =
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy =
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const next = e.altKey
          ? clampToViewport(
              { ...s.rect, w: s.rect.w + dx, h: s.rect.h + dy },
              window.innerWidth,
              window.innerHeight
            )
          : clampToViewport(
              { ...s.rect, x: s.rect.x + dx, y: s.rect.y + dy },
              window.innerWidth,
              window.innerHeight
            );
        s.setRect(next);
        return;
      }

      const k = e.key.toLowerCase();
      if (k === "l") {
        // Restore the previous session's rect. Rect-shaped modes only —
        // Freehand / Pen / Brush have no rect to restore into, and
        // Window / Object select whole targets rather than an area.
        const s = useOverlayStore.getState();
        if (!s.lastRegion || !RECT_MODES.has(s.mode)) return;
        e.preventDefault();
        s.restoreLastRegion((r) =>
          clampToViewport(r, window.innerWidth, window.innerHeight)
        );
        return;
      }
      if (k === "r" || k === "w") {
        // Swap overlay capture-type in place. Re-opening re-snapshots
        // the desktop (and, for Window, re-enumerates); OVERLAY_OPENING
        // resets state + sets the new mode. No-op if already there.
        const target = k === "r" ? "region" : "window";
        if (useOverlayStore.getState().mode !== target) {
          e.preventDefault();
          reset();
          void beginRegionCapture(target);
        }
        return;
      }
      if (k === "f") {
        // Capture the monitor under the cursor straight out of the
        // cached snapshot — no overlay round-trip, no bounce back to the
        // capture window.
        e.preventDefault();
        captureFullscreenFromOverlay();
        return;
      }
      // C is not bound — the disabled tile cue is visible enough.
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [helpOpen, reset, setHelpOpen, finalize]);
}
