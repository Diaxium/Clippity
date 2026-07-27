import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as PointerEventReact,
} from "react";

import { hasInk, paintSegment } from "../brushMask";
import { useOverlayStore } from "../state/overlayStore";
import type { Pt } from "../types";

interface BrushPointerHandlers {
  onPointerDown(e: PointerEventReact): void;
  onPointerMove(e: PointerEventReact): void;
  onPointerUp(e: PointerEventReact): void;
}

const WHEEL_STEP = 4;

/**
 * Brush interaction: press-drag to paint into the offscreen mask
 * (`brushMask.ts`); the mouse wheel resizes the brush; holding Alt (or
 * the Add/Subtract toggle set to Subtract) erases instead of paints.
 * Each stroke segment bumps the store's `brushVersion` so the visible
 * `BrushMask` layer re-blits; on release the mask is scanned once for
 * ink to decide Capture-readiness.
 *
 * The painted pixels live in the `brushMask` module, not the store, so
 * the ~120 Hz paint loop never churns React state beyond a counter.
 */
export function useBrushSelection(): BrushPointerHandlers {
  const bumpBrush = useOverlayStore((s) => s.bumpBrush);
  const commitBrush = useOverlayStore((s) => s.commitBrush);
  const setBrushSize = useOverlayStore((s) => s.setBrushSize);
  const setCursor = useOverlayStore((s) => s.setCursor);
  const setCursorPin = useOverlayStore((s) => s.setCursorPin);
  const last = useRef<Pt | null>(null);

  // Mouse wheel resizes the brush while in Brush mode (the hook is always
  // mounted, so gate on the live mode).
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (useOverlayStore.getState().mode !== "brush") return;
      e.preventDefault();
      const cur = useOverlayStore.getState().brushSize;
      setBrushSize(cur + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [setBrushSize]);

  const onPointerDown = useCallback(
    (e: PointerEventReact) => {
      if (e.button !== 0) return;
      const s = useOverlayStore.getState();
      const p = { x: e.clientX, y: e.clientY };
      const subtract = s.brushMode === "subtract" || e.altKey;
      paintSegment(p, p, s.brushSize, subtract);
      last.current = p;
      bumpBrush();
      setCursor(p);
      setCursorPin(p);
    },
    [bumpBrush, setCursor, setCursorPin]
  );

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      const p = { x: e.clientX, y: e.clientY };
      setCursor(p);
      if ((e.buttons & 1) !== 1) {
        last.current = null;
        return;
      }
      const subtract = s.brushMode === "subtract" || e.altKey;
      paintSegment(last.current ?? p, p, s.brushSize, subtract);
      last.current = p;
      bumpBrush();
      setCursorPin(p);
    },
    [bumpBrush, setCursor, setCursorPin]
  );

  const onPointerUp = useCallback(
    (_e: PointerEventReact) => {
      last.current = null;
      commitBrush(hasInk());
    },
    [commitBrush]
  );

  return { onPointerDown, onPointerMove, onPointerUp };
}
