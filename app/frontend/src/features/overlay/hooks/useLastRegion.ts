import { useCallback, useEffect } from "react";

import { lastRegion } from "@services/tauri/clients/overlay";

import { clampToViewport } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";
import type { Rect } from "../types";

interface LastRegionRestore {
  /** Whether a previous region exists to restore. Drives the toolbar
   *  button's enabled state; false until the fetch resolves. */
  available: boolean;
  /** Put the remembered rect back as a committed selection. No-op when
   *  nothing is remembered. */
  restore: () => void;
}

/**
 * "Capture that same spot again" — the overlay half.
 *
 * Fetches the remembered rect once per overlay mount into
 * `overlayStore.lastRegion`, and hands back a `restore` that drops it in
 * as a committed (`selected`) selection: handles on, Capture live. The
 * user can then nudge it — arrow keys, or an Alt-damped handle drag (see
 * `precisionPointer`) — or just press Enter.
 *
 * The rect crosses the IPC seam in physical px (the space the backend
 * crops in) and is divided by `devicePixelRatio` here — the same seam
 * `useOverlayFinalize`'s `scaleRect` multiplies at, in reverse.
 *
 * Restoring only writes `rect`, never `mode`, so a Palette or Grab-Text
 * session can reuse the area of the last Rectangle capture.
 */
export function useLastRegion(): LastRegionRestore {
  const remembered = useOverlayStore((s) => s.lastRegion);
  const setLastRegion = useOverlayStore((s) => s.setLastRegion);
  const restoreLastRegion = useOverlayStore((s) => s.restoreLastRegion);

  // One fetch per mount. The overlay window is reused across sessions,
  // but the React tree survives with it, so `reset()` alone won't re-run
  // this — and the stored value only changes when a capture completes,
  // which tears the session down anyway.
  useEffect(() => {
    let cancelled = false;
    lastRegion()
      .then((region) => {
        if (cancelled || !region) return;
        const dpr = window.devicePixelRatio || 1;
        setLastRegion({
          x: region.x / dpr,
          y: region.y / dpr,
          w: region.width / dpr,
          h: region.height / dpr,
        });
      })
      .catch(() => {
        // Nothing remembered yet, or no Tauri context (browser preview).
        // The action simply stays disabled — not worth a toast.
      });
    return () => {
      cancelled = true;
    };
  }, [setLastRegion]);

  const restore = useCallback(() => {
    // Clamp on the way in: the backend resolved the rect against the
    // whole virtual desktop, but this window's viewport is what the
    // selection UI can actually address.
    restoreLastRegion((r: Rect) =>
      clampToViewport(r, window.innerWidth, window.innerHeight)
    );
  }, [restoreLastRegion]);

  return { available: remembered !== null, restore };
}
