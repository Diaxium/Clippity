import { useCallback, type PointerEvent as PointerEventReact } from "react";

import { MIN_SIZE, rectFromPoints, snapSquare } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";
// Multi-Area draws the same rects as Region, so it gets the same
// Alt-damped micro-adjustment.
import { actionPoint } from "./actionPoint";

interface MultiAreaPointerHandlers {
  onPointerDown(e: PointerEventReact): void;
  onPointerMove(e: PointerEventReact): void;
  onPointerUp(e: PointerEventReact): void;
}

/**
 * Multi-Area pointer interaction: drag a rectangle, release to commit it
 * to the area list, repeat. Each drag reuses the Region drag mechanic
 * (`start`/`cur` + Shift-square), but pointer-up appends the rect to
 * `areas` instead of advancing a single selection. Capture / Enter then
 * stitches every committed area (via `useOverlayFinalize`); Backspace
 * (in `useOverlayKeybinds`) pops the last one.
 *
 * A drag below `MIN_SIZE` is discarded without committing — the
 * already-committed areas survive (Multi-Area readiness keys off the
 * area count, not the phase).
 */
export function useMultiAreaSelection(): MultiAreaPointerHandlers {
  const startDrag = useOverlayStore((s) => s.startDrag);
  const updateDrag = useOverlayStore((s) => s.updateDrag);
  const endDrag = useOverlayStore((s) => s.endDrag);
  const commitArea = useOverlayStore((s) => s.commitArea);
  const setCursor = useOverlayStore((s) => s.setCursor);
  const setCursorPin = useOverlayStore((s) => s.setCursorPin);

  const onPointerDown = useCallback(
    (e: PointerEventReact) => {
      if (e.button !== 0) return;
      // Always begin a fresh rect — Multi-Area accumulates areas rather
      // than editing one selection.
      startDrag(actionPoint(e));
    },
    [startDrag]
  );

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      const p = actionPoint(e);
      setCursor(p);
      if (s.phase === "dragging" && s.start) {
        updateDrag(e.shiftKey ? snapSquare(s.start, p) : p);
      }
    },
    [setCursor, updateDrag]
  );

  const onPointerUp = useCallback(
    (_e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      if (s.phase !== "dragging" || !s.start || !s.cur) return;
      const r = rectFromPoints(s.start, s.cur);
      if (r.w < MIN_SIZE || r.h < MIN_SIZE) {
        // Too small to be a real area — drop the in-progress drag but
        // keep the committed list intact.
        endDrag(null);
        return;
      }
      commitArea(r);
      setCursorPin(s.cur);
    },
    [commitArea, endDrag, setCursorPin]
  );

  return { onPointerDown, onPointerMove, onPointerUp };
}
