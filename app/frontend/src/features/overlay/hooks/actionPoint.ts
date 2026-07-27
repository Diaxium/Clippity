import type { PointerEvent as PointerEventReact } from "react";

import { precisionPoint } from "../precisionPointer";
import { useOverlayStore } from "../state/overlayStore";
import type { Pt } from "../types";
import { isSelectionDragActive } from "./useRegionSelection";

/**
 * The point an overlay interaction should act on: the raw pointer
 * position, damped while the precision modifier is held so the reticle
 * can be walked pixel by pixel (see `precisionPointer`).
 *
 * Shared by every rect/pixel mode — Region and friends, Multi-Area,
 * Color-Pick — so they all agree on where the pointer "is". Pass EVERY
 * pointer event through it, pointer-down included, or the delta chain
 * the damping integrates develops gaps.
 *
 * **The modifier is read from `e.altKey`, never from `store.precision`.**
 * On Windows a lone Alt press activates the system menu bar and the
 * webview never receives the matching keyup — a flag maintained by
 * keydown/keyup latches on, and the release is silently never observed.
 * That is invisible in a browser preview (where synthetic keyups always
 * arrive) and reliably broken in the packaged app. Pointer events carry
 * the live modifier state on the very stream this code already runs on,
 * so reading it here cannot drift.
 *
 * `store.precision` is still maintained — the magnifier's pixel grid and
 * the crosshair's arm length read it — but it is now a mirror of what
 * the pointer stream reports, not the source of truth. Key handlers keep
 * it responsive while the pointer is stationary; this keeps it honest.
 */
export function actionPoint(e: PointerEventReact): Pt {
  const s = useOverlayStore.getState();
  const precision = e.altKey;
  if (s.precision !== precision) s.setPrecision(precision);
  // Snapping the reticle back is safe unless a drag is mid-flight, where
  // it would take the selection edge with it.
  const canResync = s.phase !== "dragging" && !isSelectionDragActive();
  return precisionPoint(
    e.nativeEvent,
    { x: e.clientX, y: e.clientY },
    precision,
    window.innerWidth,
    window.innerHeight,
    canResync
  );
}
