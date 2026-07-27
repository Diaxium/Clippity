import { useCallback, useEffect } from "react";

import {
  onOverlayOpening,
  onOverlayShown,
  overlayWindows,
} from "@services/tauri/clients/overlay";
import { createLogger } from "@shared/lib/logger";

import { useOverlayStore } from "../state/overlayStore";
import type { OverlayMode } from "../types";

const log = createLogger("overlay");

/** The two modes that pick a target by hovering a window frame: Window
 *  (captures it) and Record-Window (records it). Both need the list. */
function isWindowPickMode(mode: OverlayMode): boolean {
  return mode === "window" || mode === "record-window";
}

/**
 * Owns the Window-mode target list.
 *
 * The backend enumerates capturable top-level windows when the overlay
 * opens in `window` mode — frozen at the same instant as the desktop
 * snapshot, while our own windows are still hidden — and caches them.
 * This hook pulls that cache into the store so `useWindowSelection` can
 * hit-test the cursor against it and `WindowHighlight` can draw it.
 *
 * Keyed off the event payload's `mode` (not the store's `mode`) so it
 * doesn't depend on `useOverlaySnapshot`'s `setMode` having run first,
 * and so a non-Window session always clears the list — a Region
 * selection can never inherit a stale highlight set. Best-effort: a
 * failed fetch just leaves the list empty (no highlight until the next
 * open).
 */
export function useOverlayWindows() {
  const setWindows = useOverlayStore((s) => s.setWindows);

  const load = useCallback(async () => {
    try {
      setWindows(await overlayWindows());
    } catch (err) {
      log.warn("failed to load overlay windows", err);
      setWindows([]);
    }
  }, [setWindows]);

  // Cold mount: the overlay window is reused, so it may already be open
  // in Window mode by the time React mounts. The backend returns [] in
  // any other mode, so this is safe to call unconditionally.
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return onOverlayOpening((payload) => {
      if (isWindowPickMode(payload.mode)) void load();
      else setWindows([]);
    });
  }, [load, setWindows]);

  useEffect(() => {
    return onOverlayShown((payload) => {
      if (isWindowPickMode(payload.mode)) void load();
      else setWindows([]);
    });
  }, [load, setWindows]);
}
