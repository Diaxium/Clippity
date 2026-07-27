import { useCallback, type PointerEvent as PointerEventReact } from "react";

import { farEnough, MIN_FREEHAND_DIST, MIN_FREEHAND_POINTS } from "../geometry";
import { snapToEdge, SNAP_RADIUS } from "../edges";
import { useOverlayStore, type OverlayStoreState } from "../state/overlayStore";
import type { Pt } from "../types";

interface MagneticLassoHandlers {
  onPointerDown(e: PointerEventReact): void;
  onPointerMove(e: PointerEventReact): void;
  onPointerUp(e: PointerEventReact): void;
}

/**
 * Magnetic-lasso interaction: press-drag to trace an object; each
 * appended point is snapped to the strongest nearby image edge (Sobel
 * over the cached desktop snapshot, see `edges.ts`) so the selection
 * hugs the object boundary without pixel-precise mouse work. Release
 * with ≥ `MIN_FREEHAND_POINTS` snapped points advances to `selected`.
 *
 * Reuses the Freehand path state (`freehandPath` is just an ordered
 * point list, and the two modes are mutually exclusive) and the Freehand
 * mask sink at finalize — the only difference from `useFreehandSelection`
 * is the per-point edge snap. The crosshair tracks the RAW cursor for
 * responsiveness; the path captures the snapped points.
 */
export function useMagneticLasso(): MagneticLassoHandlers {
  const beginFreehand = useOverlayStore((s) => s.beginFreehand);
  const extendFreehand = useOverlayStore((s) => s.extendFreehand);
  const endFreehand = useOverlayStore((s) => s.endFreehand);
  const setCursor = useOverlayStore((s) => s.setCursor);
  const setCursorPin = useOverlayStore((s) => s.setCursorPin);

  const onPointerDown = useCallback(
    (e: PointerEventReact) => {
      if (e.button !== 0) return;
      const s = useOverlayStore.getState();
      const p = snap(s, { x: e.clientX, y: e.clientY });
      beginFreehand(p);
      setCursorPin(p);
    },
    [beginFreehand, setCursorPin]
  );

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      const raw = { x: e.clientX, y: e.clientY };
      if (s.phase !== "dragging") {
        setCursor(raw);
        return;
      }
      const last = s.freehandPath[s.freehandPath.length - 1];
      if (!last || farEnough(last, raw, MIN_FREEHAND_DIST)) {
        const p = snap(s, raw);
        extendFreehand(p);
        setCursorPin(p);
        // Keep the crosshair on the raw cursor — only the captured point
        // snaps, so the pointer stays responsive.
        setCursor(raw);
      } else {
        setCursor(raw);
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

/** Snap `p` to the nearest strong edge in the cached snapshot, or return
 *  `p` unchanged when there's no snapshot / no edge nearby. */
function snap(s: OverlayStoreState, p: Pt): Pt {
  const ctx = s.snapshot.sampleCtx;
  if (!ctx) return p;
  const dpr = window.devicePixelRatio || 1;
  return snapToEdge(ctx, p, SNAP_RADIUS, dpr);
}
