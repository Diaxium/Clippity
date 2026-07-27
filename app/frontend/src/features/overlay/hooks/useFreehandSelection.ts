import { useCallback, type PointerEvent as PointerEventReact } from "react";

import { farEnough, MIN_FREEHAND_DIST, MIN_FREEHAND_POINTS } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";

interface FreehandPointerHandlers {
  onPointerDown(e: PointerEventReact): void;
  onPointerMove(e: PointerEventReact): void;
  onPointerUp(e: PointerEventReact): void;
}

/**
 * Freehand (lasso) pointer interaction: press-drag to draw a freeform
 * path, release to finalize. Points are subsampled (`MIN_FREEHAND_DIST`)
 * so the ~120 Hz move stream doesn't bloat the polygon. On release a
 * path with at least `MIN_FREEHAND_POINTS` points advances to the
 * `selected` phase (Capture / Enter then finalizes via
 * `useOverlayFinalize`); a too-short path is discarded back to idle.
 *
 * Mirrors `useRegionSelection`'s reads-via-`getState()` pattern so the
 * pointer-move path doesn't re-subscribe the component every frame.
 */
export function useFreehandSelection(): FreehandPointerHandlers {
  const beginFreehand = useOverlayStore((s) => s.beginFreehand);
  const extendFreehand = useOverlayStore((s) => s.extendFreehand);
  const endFreehand = useOverlayStore((s) => s.endFreehand);
  const setCursor = useOverlayStore((s) => s.setCursor);
  const setCursorPin = useOverlayStore((s) => s.setCursorPin);

  const onPointerDown = useCallback(
    (e: PointerEventReact) => {
      if (e.button !== 0) return;
      const p = { x: e.clientX, y: e.clientY };
      beginFreehand(p);
      setCursorPin(p);
    },
    [beginFreehand, setCursorPin]
  );

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      const p = { x: e.clientX, y: e.clientY };
      // Always keep the crosshair / loupe tracking the cursor.
      if (s.phase !== "dragging") {
        setCursor(p);
        return;
      }
      // Subsample: only append once the cursor has travelled far enough
      // from the last recorded point.
      const last = s.freehandPath[s.freehandPath.length - 1];
      if (!last || farEnough(last, p, MIN_FREEHAND_DIST)) {
        extendFreehand(p);
        setCursorPin(p);
      } else {
        setCursor(p);
      }
    },
    [extendFreehand, setCursor, setCursorPin]
  );

  const onPointerUp = useCallback(
    (_e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      if (s.phase !== "dragging") return;
      endFreehand(s.freehandPath.length >= MIN_FREEHAND_POINTS);
    },
    [endFreehand]
  );

  return { onPointerDown, onPointerMove, onPointerUp };
}
