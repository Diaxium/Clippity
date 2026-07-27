import { emit } from "@tauri-apps/api/event";

import { EVENT_NAMES, invoke, on } from "@services/tauri";

import type {
  OverlayResult,
  Region,
  ScrollDirection,
  RecordingTick,
  RecordingPreview,
} from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::scroll`) ----------
export type { ScrollDirection, RecordingTick, RecordingPreview } from "@clippity/shared";

/**
 * Scrolling-Window recording (ADR 0008). `start` hides the overlay and
 * begins the worker (the user scrolls the content beneath); the recording
 * HUD toast drives `stop`. `stop(discard)` returns the stitched capture
 * or `null` (discarded / nothing recording). `direction` sets the axis
 * the frames are stitched along.
 */
export function startScrollCapture(
  rect: Region,
  direction: ScrollDirection,
  clipboard: boolean,
  preview: boolean
): Promise<void> {
  return invoke<
    void,
    { rect: Region; direction: ScrollDirection; clipboard: boolean; preview: boolean }
  >("start_scroll_capture", { rect, direction, clipboard, preview });
}

/**
 * Panoramic (auto-scroll) recording. Like {@link startScrollCapture},
 * but the backend drives the scroll itself — it parks the cursor over
 * the region and wheels through the content in `direction`, capturing
 * until the view stops advancing (end reached) or the HUD's Stop is
 * pressed. The user doesn't scroll. Same `stopScrollCapture` +
 * `recording/*` events.
 */
export function startPanoramicCapture(
  rect: Region,
  direction: ScrollDirection,
  clipboard: boolean,
  preview: boolean
): Promise<void> {
  return invoke<
    void,
    { rect: Region; direction: ScrollDirection; clipboard: boolean; preview: boolean }
  >("start_panoramic_capture", { rect, direction, clipboard, preview });
}

/** Capture-window → overlay mirror of the chosen scroll direction, so
 *  the overlay's direction control starts from what the user pre-set
 *  (mirrors `emitOverlayToggles`). Frontend-to-frontend event. */
export async function emitOverlayScrollDirection(
  direction: ScrollDirection
): Promise<void> {
  await emit(EVENT_NAMES.overlayScrollDirection, direction);
}

/** Overlay-side listener for the mirrored scroll direction. */
export function onOverlayScrollDirection(
  handler: (direction: ScrollDirection) => void
): () => void {
  return on<ScrollDirection>(EVENT_NAMES.overlayScrollDirection, handler);
}

export function stopScrollCapture(
  discard: boolean
): Promise<OverlayResult | null> {
  return invoke<OverlayResult | null, { discard: boolean }>(
    "stop_scroll_capture",
    { discard }
  );
}

export function onRecordingTick(cb: (e: RecordingTick) => void): () => void {
  return on<RecordingTick>(EVENT_NAMES.recordingTick, cb);
}

export function onRecordingPreview(
  cb: (e: RecordingPreview) => void
): () => void {
  return on<RecordingPreview>(EVENT_NAMES.recordingPreview, cb);
}

/**
 * Fires once when the worker detects the user reversed scroll direction
 * (scrolled back the way they came) — the cue the capture is complete.
 * The recording HUD commits in response (same as Stop & Stitch). Payload
 * is empty; the callback takes no argument.
 */
export function onRecordingAutoStop(cb: () => void): () => void {
  return on<unknown>(EVENT_NAMES.recordingAutoStop, () => cb());
}
