import { useCallback, type PointerEvent as PointerEventReact } from "react";

import { finishRegionCapture } from "@services/tauri/clients/overlay";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { objectIndexAtPoint } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";

interface ObjectPointerHandlers {
  onPointerMove(e: PointerEventReact): void;
  onPointerDown(e: PointerEventReact): void;
}

/**
 * Object-mode pointer interaction: hovering highlights the AI-detected
 * element under the cursor (smallest containing box, so nested
 * detections stay reachable); a left click captures it.
 *
 * Mirrors `useWindowSelection`'s shape — the hit-test reads `objects`
 * via `getState()` so the ~120 Hz pointer-move path doesn't
 * re-subscribe, and only `hoveredObjectIndex` changes flow back out.
 * The detection rect is ALREADY physical px (virtual-desktop origin),
 * so it goes to `finishRegionCapture` with NO devicePixelRatio scaling
 * — a detected object is just a pre-snapped region.
 */
export function useObjectSelection(): ObjectPointerHandlers {
  const setHoveredObject = useOverlayStore((s) => s.setHoveredObject);

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      const dpr = window.devicePixelRatio || 1;
      const hit = objectIndexAtPoint(
        useOverlayStore.getState().objects,
        { x: e.clientX, y: e.clientY },
        dpr
      );
      setHoveredObject(hit);
    },
    [setHoveredObject]
  );

  const onPointerDown = useCallback((e: PointerEventReact) => {
    if (e.button !== 0) return;
    const s = useOverlayStore.getState();
    const dpr = window.devicePixelRatio || 1;
    // Re-hit-test on the actual down position rather than trusting the
    // last hover — a click can land a few px off the last move event.
    const hit = objectIndexAtPoint(
      s.objects,
      { x: e.clientX, y: e.clientY },
      dpr
    );
    const obj = hit === null ? undefined : s.objects[hit];
    if (!obj) return;
    // Fire the flash immediately so the user sees feedback before the
    // IPC round-trip returns (mirrors the Window-mode click path).
    s.fireCaptureFlash();
    finishRegionCapture({ rect: obj.rect, cursorPin: null, toggles: s.toggles })
      .then(() => useOverlayStore.getState().reset())
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "Capture failed.";
        void emitErrorToast(message);
      });
  }, []);

  return { onPointerMove, onPointerDown };
}
