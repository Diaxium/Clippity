import { useCallback, type PointerEvent as PointerEventReact } from "react";

import { pickColor } from "@services/tauri/clients/overlay";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { useOverlayStore } from "../state/overlayStore";
// Sampling a single pixel out of a dense UI is the sharpest case for the
// Alt damping, and the click must sample where the loupe's reticle sits,
// not where the OS cursor drifted to.
import { actionPoint } from "./actionPoint";

interface ColorPickPointerHandlers {
  onPointerMove(e: PointerEventReact): void;
  onPointerDown(e: PointerEventReact): void;
}

/**
 * Color-Picker pointer interaction: move tracks the crosshair + loupe so
 * the user can see the pixel they're about to sample; a left click sends
 * the canvas-local physical-pixel coordinate to the backend, which
 * samples the cached snapshot, copies the hex to the clipboard, and
 * surfaces a color toast. No drag, no Capture button — one click is the
 * whole interaction. The backend hides the overlay + restores the
 * previous window, so the frontend just resets local state.
 */
export function useColorPick(): ColorPickPointerHandlers {
  const setCursor = useOverlayStore((s) => s.setCursor);

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      setCursor(actionPoint(e));
    },
    [setCursor]
  );

  const onPointerDown = useCallback((e: PointerEventReact) => {
    if (e.button !== 0) return;
    const dpr = window.devicePixelRatio || 1;
    const p = actionPoint(e);
    const x = Math.round(p.x * dpr);
    const y = Math.round(p.y * dpr);
    const reset = () => useOverlayStore.getState().reset();
    pickColor(x, y)
      .then(reset)
      .catch((err: unknown) => {
        void emitErrorToast(
          err instanceof Error ? err.message : "Color pick failed."
        );
        reset();
      });
  }, []);

  return { onPointerMove, onPointerDown };
}
