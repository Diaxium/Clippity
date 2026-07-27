import { useEffect } from "react";

import { onCaptureFinished } from "@services/tauri/clients/capture";
import { openDashboard } from "@services/tauri/clients/dashboard";

/**
 * Open the editor on any capture that asked for it.
 *
 * The backend stamps the "Preview in Editor" toggle onto every
 * `clippity://capture/finished` payload — for every mode that produces
 * an editable PNG (fullscreen, region, window, freehand, multi-area,
 * scrolling-window). The aux modes (color-pick / palette / grab-text)
 * never emit `capture/finished`, so they're naturally excluded.
 *
 * Mounted once in the always-alive main window, this is the single place
 * that reacts: when `preview` is set, focus the dashboard's editor on the
 * saved path. `openDashboard` shows + focuses the (possibly hidden) main
 * window and routes it to the editor view.
 *
 * Why here, not per-dispatch arming: a capture is finalized in the
 * overlay / recording HUD long after — and usually in a different window
 * than — the dispatch that opened it, and the user can flip the toggle
 * mid-overlay. Reading the flag off the result means the decision always
 * matches the toggle the capture actually used and works for every entry
 * point (capture window, tray, overlay sidebar / keybinds, presets)
 * without each one arming (and leaking) its own listener.
 */
export function useOpenEditorOnPreview(): void {
  useEffect(() => {
    return onCaptureFinished((result) => {
      if (result.preview) void openDashboard("editor", result.path);
    });
  }, []);
}
