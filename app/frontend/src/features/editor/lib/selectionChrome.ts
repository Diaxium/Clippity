/**
 * Shared geometry for the floating selection chrome — the action toolbar
 * (`FloatingToolbar`) and the object size label (`ObjectLabel`). Both layers
 * anchor to the same selection; keeping the side-of-selection decision in one
 * pure module guarantees they agree on who goes where, so they take *opposite*
 * sides and can never stack on top of each other (or both vanish) the way two
 * independent "anchor below the selection" components used to.
 *
 * All inputs are in canvas/screen space (zoom + pan already applied).
 */

/** Gap between the selection edge and a chrome element. */
export const CHROME_GAP = 12;
/** Minimum breathing room from the canvas edges. */
export const CHROME_MARGIN = 8;
/** Height of the canvas's bottom rail plus a gap — chrome clamps above this
 *  strip so it never covers the rail. The hint bar and the zoom cluster now
 *  *stack* (both centred) rather than sitting side by side, so the strip is
 *  roughly twice as tall as it was. */
export const CHROME_BOTTOM_RAIL = 92;

export type ChromeSide = "above" | "below" | "pinned";

/**
 * Which side of the selection a fixed-height floating element sits on. Prefers
 * above the selection; flips below when there's no headroom; pins just above
 * the bottom rail when the selection spans the whole viewport (no room either
 * side).
 *
 * @param topY    selection AABB top
 * @param bottomY selection AABB bottom
 * @param canvasH canvas viewport height
 * @param h       the element's own height
 */
export function chromeSide(
  topY: number,
  bottomY: number,
  canvasH: number,
  h: number
): ChromeSide {
  const railTop = canvasH - CHROME_BOTTOM_RAIL;
  if (topY - CHROME_GAP - h >= CHROME_MARGIN) return "above";
  if (bottomY + CHROME_GAP + h <= railTop) return "below";
  return "pinned";
}

export interface ChromeVerticalPos {
  top: number;
  /** CSS translateY component for the element's transform. */
  translateY: string;
}

/** Resolve `top` + `translateY` for an element placed on the given side. */
export function chromeVerticalPos(
  side: ChromeSide,
  topY: number,
  bottomY: number,
  canvasH: number,
  h: number
): ChromeVerticalPos {
  const railTop = canvasH - CHROME_BOTTOM_RAIL;
  if (side === "above") {
    // Hangs upward from `top`; keep the anchor above the rail.
    return { top: Math.min(topY - CHROME_GAP, railTop), translateY: "-100%" };
  }
  if (side === "below") {
    return { top: bottomY + CHROME_GAP, translateY: "0" };
  }
  // Pinned: selection spans the viewport — sit just above the bottom rail,
  // overlaying the selection edge.
  return { top: Math.max(CHROME_MARGIN, railTop - h), translateY: "0" };
}

/* -------------------------------------------------------------------------- */
/*  Horizontal placement                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The vertical axis is already spoken for: the toolbar takes one side of the
 * selection and the size label takes the other (see above). A *third* floating
 * layer — the Annotation inspector — therefore anchors on the **horizontal**
 * axis instead, which keeps it out of that arbitration entirely rather than
 * making it a three-way negotiation.
 */
export type ChromeXSide = "right" | "left" | "clamped";

/**
 * Which side of the selection a fixed-width floating element sits on. Prefers
 * the right of the selection (the inspector's habitual home), flips left when
 * there's no room, and clamps to the right canvas edge when the selection is
 * wider than the space either side.
 *
 * @param leftX   selection AABB left
 * @param rightX  selection AABB right
 * @param canvasW canvas viewport width
 * @param w       the element's own width
 */
export function chromeXSide(
  leftX: number,
  rightX: number,
  canvasW: number,
  w: number
): ChromeXSide {
  if (rightX + CHROME_GAP + w <= canvasW - CHROME_MARGIN) return "right";
  if (leftX - CHROME_GAP - w >= CHROME_MARGIN) return "left";
  return "clamped";
}

/** Resolve the `left` offset for an element placed on the given side. */
export function chromeXPos(
  side: ChromeXSide,
  leftX: number,
  rightX: number,
  canvasW: number,
  w: number
): number {
  if (side === "right") return rightX + CHROME_GAP;
  if (side === "left") return leftX - CHROME_GAP - w;
  // No room either side — pin to the right edge, but never off the left.
  return Math.max(CHROME_MARGIN, canvasW - w - CHROME_MARGIN);
}
