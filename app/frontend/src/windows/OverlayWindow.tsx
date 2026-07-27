import { OverlayLayout } from "@features/overlay";

/**
 * Region-selection overlay — the full-screen transparent window the
 * user drags a capture region inside. The Rust side positions + sizes
 * the window to the virtual desktop in `show_region_overlay`; the
 * React tree owns everything inside.
 */
export function OverlayWindow() {
  return <OverlayLayout />;
}
