import { finishFullscreenCapture } from "@services/tauri/clients/overlay";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { useOverlayStore } from "../state/overlayStore";

/**
 * Fire a Fullscreen capture from inside the overlay — the `F` keybind,
 * the BottomToolbar's Fullscreen tab, and the CaptureTypeSidebar all
 * land here.
 *
 * Previously each of those cancelled the overlay and bounced the user
 * back to the capture window to press Capture again, because closing the
 * overlay and re-grabbing the screen risks catching Clippity's own
 * chrome in the shot. The backend sidesteps that entirely: it crops the
 * monitor under the cursor out of the snapshot the overlay is already
 * displaying, so what gets saved is exactly the frozen backdrop on
 * screen — and on a multi-monitor desktop it's the screen the user is
 * actually pointing at, not whichever one Windows calls primary.
 *
 * No rect crosses the IPC seam (so no `devicePixelRatio` scaling here)
 * and no cursor pin: the whole monitor is in frame, so the live cursor
 * position is already the honest one. Mirrors `captureWindow`'s shape —
 * flash, finalize, reset, toast on failure.
 */
export function captureFullscreenFromOverlay(): void {
  const s = useOverlayStore.getState();
  s.fireCaptureFlash();
  finishFullscreenCapture(s.toggles)
    .then(() => useOverlayStore.getState().reset())
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : "Capture failed.";
      void emitErrorToast(message);
    });
}
