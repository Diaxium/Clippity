/**
 * Where a popover goes when it can't live inside its host.
 *
 * The library's popovers are triggered from inside things that clip: a
 * capture card is `overflow-hidden` (its rounded corners depend on it),
 * the grid scrolls, and the selection bar is pinned to the bottom of the
 * window with nothing below it. So the panels render in a portal, and
 * this is the arithmetic that puts them back where they belong. Pure, so
 * the flip-and-clamp behaviour is testable without a layout engine.
 */

/** Gap between a panel and the trigger it hangs off. */
export const ANCHOR_GAP = 6;

/** Closest a panel is allowed to get to the edge of the window. */
export const ANCHOR_MARGIN = 8;

/** The part of a trigger's box that matters for placement. */
export interface AnchorRect {
  top: number;
  bottom: number;
  right: number;
}

export interface PanelSize {
  width: number;
  /** `0` before the panel has been measured — it then places below,
   *  which is the common case, and re-places once it has a height. */
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/**
 * Viewport coordinates for a panel anchored under `trigger`.
 *
 * Right-aligned, because every trigger here sits at the right end of an
 * action cluster and a left-aligned panel would hang off the card.
 * Flipped above the trigger when the space below can't hold it — which
 * is the *only* option for the selection bar, where "below" is off the
 * bottom of the window entirely. Clamped on every side, so a card at the
 * edge of the window still gets a fully visible panel.
 */
export function placePanel(
  trigger: AnchorRect,
  panel: PanelSize,
  viewport: Viewport
): { top: number; left: number } {
  const left = Math.max(
    ANCHOR_MARGIN,
    Math.min(
      trigger.right - panel.width,
      viewport.width - panel.width - ANCHOR_MARGIN
    )
  );

  const below = trigger.bottom + ANCHOR_GAP;
  const fitsBelow =
    panel.height === 0 ||
    below + panel.height <= viewport.height - ANCHOR_MARGIN;

  // A panel taller than the space above *and* below still has to land
  // somewhere on screen; the top margin wins over the flip.
  const top = fitsBelow
    ? below
    : Math.max(ANCHOR_MARGIN, trigger.top - panel.height - ANCHOR_GAP);

  return { top, left };
}
