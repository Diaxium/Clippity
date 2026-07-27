import { CaptureLayout } from "@features/capture";

/**
 * Capture window — the primary workflow hub for selecting a capture
 * mode and triggering a capture. Default window opened at app launch.
 *
 * Composition lives entirely in `@features/capture` so this file
 * stays a one-liner — exactly the boundary that
 * [`features/README.md`](../features/README.md) prescribes.
 */
export function CaptureWindow() {
  return <CaptureLayout />;
}
