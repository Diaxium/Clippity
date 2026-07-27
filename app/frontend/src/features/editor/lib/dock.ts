/**
 * Pure geometry for docking the inspector to a workspace edge.
 *
 * The inspector exists in two forms — a docked rail and a floating panel — and
 * this module owns the one decision that connects them: given a pointer during
 * a drag, which edge (if any) would receive a drop. Keeping it pure means the
 * snap threshold, the dead zone in the middle, and the tie-breaking are all
 * unit-testable without a DOM, which the components hosting them are not.
 *
 * All inputs are in client/screen space.
 */

/** Which edge the inspector is attached to; `null` = floating. */
export type DockSide = "left" | "right";

/**
 * How close to an edge a drag must get before it snaps. Generous on purpose —
 * this is a coarse gesture, and an undershoot silently leaves the panel
 * floating, which reads as the drop having failed.
 */
export const DOCK_SNAP_PX = 72;

/**
 * The edge a pointer at `x` would dock to inside a container spanning
 * `[left, right]`, or `null` when it's in neither edge band.
 *
 * A container narrower than twice the threshold would otherwise have its two
 * bands overlap, making the middle ambiguous; there the nearer edge wins, so a
 * drop is never reported as belonging to both.
 */
export function dockTargetAt(
  x: number,
  left: number,
  right: number,
  threshold: number = DOCK_SNAP_PX
): DockSide | null {
  const width = right - left;
  if (width <= 0) return null;

  // Bands overlap on a narrow container — split at the midpoint instead.
  if (width < threshold * 2) {
    if (x < left || x > right) return null;
    return x - left < right - x ? "left" : "right";
  }

  if (x >= left && x - left <= threshold) return "left";
  if (x <= right && right - x <= threshold) return "right";
  return null;
}

/**
 * Whether a drag that started on a docked rail has pulled far enough off its
 * edge to undock. Larger than the snap threshold so the two gestures don't
 * fight: nudging a rail must not float it, and floating it must not instantly
 * re-dock.
 */
export const UNDOCK_PULL_PX = 96;

export function shouldUndock(
  side: DockSide,
  startX: number,
  x: number
): boolean {
  // Pulling *inward* (away from the panel's own edge) is what undocks.
  const pulled = side === "right" ? startX - x : x - startX;
  return pulled >= UNDOCK_PULL_PX;
}
