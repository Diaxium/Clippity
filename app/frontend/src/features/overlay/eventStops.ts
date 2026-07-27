import type {
  MouseEvent as MouseEventReact,
  PointerEvent as PointerEventReact,
} from "react";

/**
 * Spread these onto any overlay-chrome container (TopBanner /
 * BottomToolbar / CaptureTypeSidebar / future popovers) to keep
 * pointer-down, pointer-up, and click events from bubbling out to
 * the canvas-wide handlers in `useRegionSelection`.
 *
 * This is belt-and-suspenders alongside the canvas-side phase guard
 * — that guard now early-returns when phase isn't "dragging" (see
 * `useRegionSelection.test.ts` regression) but blocking at the chrome
 * boundary keeps event flow clean and saves a few cycles per click.
 *
 * Promoted from three byte-identical inline blocks during overlay
 * Step 5 cleanup. Stays feature-local until a second feature needs
 * the same shape (`shared/` promotion would be speculative today).
 */
export const CHROME_STOP_PROPS = {
  onPointerDown: (e: PointerEventReact<HTMLElement>) => e.stopPropagation(),
  onPointerUp: (e: PointerEventReact<HTMLElement>) => e.stopPropagation(),
  onClick: (e: MouseEventReact<HTMLElement>) => e.stopPropagation(),
};
