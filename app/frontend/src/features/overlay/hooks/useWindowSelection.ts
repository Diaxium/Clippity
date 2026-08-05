import { useCallback, type PointerEvent as PointerEventReact } from "react";

import { useSettingsStore } from "@features/settings";
import { finishRegionCapture } from "@services/tauri/clients/overlay";
import { startRecording } from "@services/tauri/clients/recorder";
import type { RecorderFormat } from "@services/tauri/clients/recorder";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { overlayRecorderRequest } from "@shared/lib/recorderRequest";

import { windowAtPoint } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";
import type { OverlayToggles, OverlayWindow } from "../types";

interface WindowPointerHandlers {
  onPointerMove(e: PointerEventReact): void;
  onPointerDown(e: PointerEventReact): void;
}

/**
 * Window-mode pointer interaction: a hover highlights the top-level
 * window under the cursor; a left click captures it.
 *
 * Far simpler than `useRegionSelection` — there's no drag state
 * machine, just a hit-test against the backend's Z-ordered window list
 * and a one-shot finalize. The hit-test reads `windows` straight from
 * the store via `getState()` so the ~120 Hz pointer-move path doesn't
 * re-subscribe the component on every frame; only `hoveredWindowId`
 * changes flow back out (and zustand skips the re-render when the id is
 * unchanged).
 */
export function useWindowSelection(): WindowPointerHandlers {
  const setHoveredWindow = useOverlayStore((s) => s.setHoveredWindow);

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      const dpr = window.devicePixelRatio || 1;
      const hit = windowAtPoint(
        useOverlayStore.getState().windows,
        { x: e.clientX, y: e.clientY },
        dpr
      );
      setHoveredWindow(hit?.id ?? null);
    },
    [setHoveredWindow]
  );

  const onPointerDown = useCallback((e: PointerEventReact) => {
    if (e.button !== 0) return;
    const s = useOverlayStore.getState();
    const dpr = window.devicePixelRatio || 1;
    // Re-hit-test on the actual down position rather than trusting the
    // last hover — a click can land a few px off the last move event.
    const hit = windowAtPoint(s.windows, { x: e.clientX, y: e.clientY }, dpr);
    if (!hit) return;
    const done = () => useOverlayStore.getState().reset();

    if (s.mode === "record-window") {
      // No capture flash: nothing was captured: the click *starts* a
      // recording, and a flash would say a still had been taken.
      recordWindow(hit, s.recordFormat, done);
      return;
    }

    // Fire the flash immediately so the user sees feedback before the
    // IPC round-trip returns (mirrors the Region Enter path).
    s.fireCaptureFlash();
    captureWindow(hit, s.toggles, done);
  }, []);

  return { onPointerMove, onPointerDown };
}

/**
 * Finalize a Window-mode capture: crop the chosen window's frame out of
 * the cached desktop snapshot, save, optionally copy to clipboard, emit
 * `capture/finished`. Shared by the click handler above and the Enter
 * keybind in `useOverlayKeybinds`.
 *
 * The window `rect` is ALREADY physical px (virtual-desktop origin), so
 * unlike a drag-selected Region rect it is handed to the backend with
 * NO `devicePixelRatio` scaling. `cursorPin` is null — a window capture
 * has no in-selection pointer to pin. Errors surface as a toast (the
 * overlay is already hidden by the backend on the finalize path).
 */
export function captureWindow(
  win: OverlayWindow,
  toggles: OverlayToggles,
  onDone: () => void
): void {
  finishRegionCapture({ rect: win.rect, cursorPin: null, toggles })
    .then(onDone)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Capture failed.";
      void emitErrorToast(message);
    });
}

/**
 * Start recording the chosen window (ADR 0031) — the Record-Window
 * counterpart to [`captureWindow`].
 *
 * `win.rect` is already physical px (virtual-desktop origin), so it
 * goes to the backend with no DPR scaling, exactly as the capture path
 * does. `windowId` rides along so the recording's provenance can name
 * the app.
 *
 * Shares one request builder with every other entry point so the same
 * settings can't mean different things depending on where a recording
 * was started from.
 */
export function recordWindow(
  win: OverlayWindow,
  format: RecorderFormat,
  onDone: () => void
): void {
  const request = overlayRecorderRequest(
    "window",
    format,
    useSettingsStore.getState().settings?.recording,
    useOverlayStore.getState().recordOverride,
    win.rect
  );
  startRecording({ ...request, windowId: win.id })
    .then(onDone)
    .catch((err: unknown) => {
      void emitErrorToast(
        err instanceof Error ? err.message : "Couldn't start the recording."
      );
    });
}
