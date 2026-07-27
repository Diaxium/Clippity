import { useCallback, type PointerEvent as PointerEventReact } from "react";

import { farEnough } from "../geometry";
import { useOverlayStore } from "../state/overlayStore";

interface PenPointerHandlers {
  onPointerDown(e: PointerEventReact): void;
  onPointerMove(e: PointerEventReact): void;
  onPointerUp(e: PointerEventReact): void;
}

/** Click within this many logical px of the first anchor closes the
 *  path (matches the on-screen first-anchor target radius). */
const CLOSE_DIST = 11;

/**
 * Pen / Bézier-path interaction:
 *
 *   - Click drops a hard-corner anchor.
 *   - Click-and-drag pulls out symmetric curve handles for that anchor
 *     (Alt while dragging breaks the symmetry into a cusp — only the
 *     outgoing handle is set).
 *   - Clicking back on the first anchor (≥ 3 anchors) closes the path →
 *     `selected`. `Enter` does the same via `useOverlayKeybinds`.
 *
 * Mirrors `useFreehandSelection`'s `getState()` fast-path so the
 * pointer-move stream doesn't re-subscribe the component each frame.
 * The closed path is flattened to a polygon at finalize and reuses the
 * Freehand mask sink (`finishFreehandCapture`).
 */
export function usePenSelection(): PenPointerHandlers {
  const addPenAnchor = useOverlayStore((s) => s.addPenAnchor);
  const updatePenHandles = useOverlayStore((s) => s.updatePenHandles);
  const closePen = useOverlayStore((s) => s.closePen);
  const setCursor = useOverlayStore((s) => s.setCursor);
  const setCursorPin = useOverlayStore((s) => s.setCursorPin);

  const onPointerDown = useCallback(
    (e: PointerEventReact) => {
      if (e.button !== 0) return;
      const s = useOverlayStore.getState();
      if (s.phase === "selected") return; // path already closed
      const p = { x: e.clientX, y: e.clientY };
      // Close when clicking back on the first anchor (needs ≥ 3 anchors
      // to enclose an area the backend can mask).
      if (s.penPath.length >= 3) {
        const first = s.penPath[0]!.p;
        if (!farEnough(first, p, CLOSE_DIST)) {
          closePen();
          return;
        }
      }
      addPenAnchor({ p, hIn: null, hOut: null });
      setCursorPin(p);
    },
    [addPenAnchor, closePen, setCursorPin]
  );

  const onPointerMove = useCallback(
    (e: PointerEventReact) => {
      const s = useOverlayStore.getState();
      const p = { x: e.clientX, y: e.clientY };
      const dragging = (e.buttons & 1) === 1 && s.penPath.length > 0;
      if (s.phase === "selected" || !dragging) {
        setCursor(p);
        return;
      }
      // Pull curve handles out of the just-placed anchor. Symmetric by
      // default; Alt makes a cusp (no incoming handle).
      const anchor = s.penPath[s.penPath.length - 1]!.p;
      const hOut = p;
      const hIn = e.altKey
        ? null
        : { x: 2 * anchor.x - p.x, y: 2 * anchor.y - p.y };
      updatePenHandles(hIn, hOut);
      setCursor(p);
    },
    [setCursor, updatePenHandles]
  );

  const onPointerUp = useCallback((_e: PointerEventReact) => {
    // Handles are already committed during move; nothing to finalize on
    // release. The anchor stays editable until the next anchor is placed.
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp };
}
