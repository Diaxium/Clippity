/**
 * Overlay IPC client.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so cross-feature
 * consumers can import them without reaching into another feature folder. The
 * capture feature imports `beginRegionCapture` + `emitOverlayToggles` from
 * here; the overlay feature imports the rest of the surface. The wire-format
 * types live in `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::overlay::*` + `services::overlay_service::*`.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";

import { invoke, on, EVENT_NAMES } from "@services/tauri";
import type {
  OverlayMode,
  Region,
  OverlayWindow,
  DetectedObject,
  OverlayToggles,
  BeginOverlayRequest,
  FinishRegionRequest,
  FinishFreehandRequest,
  FinishBrushRequest,
  FinishMultiAreaRequest,
  OverlayResult,
  OverlayOpeningPayload,
  OverlayShownPayload,
  CaptureMeta,
  PickedColor,
} from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::overlay`) ----------
export type {
  OverlayMode,
  Region,
  OverlayWindow,
  DetectedObject,
  OverlayToggles,
  BeginOverlayRequest,
  FinishRegionRequest,
  FinishFreehandRequest,
  BrushMask,
  FinishBrushRequest,
  FinishMultiAreaRequest,
  OverlayResult,
  OverlayOpeningPayload,
  OverlayShownPayload,
} from "@clippity/shared";

// ---------- IPC wrappers ----------

/** Open the overlay for the given mode. Hides primary windows,
 *  snapshots the virtual desktop, positions + shows the overlay,
 *  emits `clippity://overlay/shown`. */
export function beginRegionCapture(
  mode: OverlayMode,
  outputDir: string | null = null,
  preset: string | null = null
): Promise<void> {
  return invoke<void, { request: BeginOverlayRequest }>(
    "begin_region_capture",
    {
      request: { mode, outputDir, preset },
    }
  );
}

/** Switch the active selection method on the open overlay session in
 *  place (Rectangle / Freehand / Pen / Magnetic Lasso / Brush share the
 *  same cached snapshot). Updates only the backend session mode so the
 *  saved file's label matches the method drawn — no re-snapshot, no
 *  flicker. No-op when no overlay session is open. */
export function setOverlayMode(mode: OverlayMode): Promise<void> {
  return invoke<void, { mode: OverlayMode }>("set_overlay_mode", { mode });
}

/** Cancel without producing a capture. Hides the overlay, restores
 *  the capture window. */
export function cancelRegionCapture(): Promise<void> {
  return invoke<void>("cancel_region_capture");
}

/** Finalize a Region selection — crop, optional cursor, save, optional
 *  clipboard, emit `clippity://capture/finished`. */
export function finishRegionCapture(
  request: FinishRegionRequest
): Promise<OverlayResult> {
  return invoke<OverlayResult, { request: FinishRegionRequest }>(
    "finish_region_capture",
    { request }
  );
}

/** Finalize a Fullscreen capture from inside the overlay (`F` / the
 *  Fullscreen tab). The backend crops the monitor the cursor is on out
 *  of the cached snapshot — the same frozen backdrop the overlay is
 *  showing — so this needs no rect from the frontend and never catches
 *  Clippity's own chrome. Saves, optional clipboard, emits
 *  `clippity://capture/finished`. */
export function finishFullscreenCapture(
  toggles: OverlayToggles
): Promise<OverlayResult> {
  return invoke<OverlayResult, { toggles: OverlayToggles }>(
    "finish_fullscreen_capture",
    { toggles }
  );
}

/** Finalize a Freehand selection — mask outside the polygon to
 *  transparent, crop to the bbox, save, optional clipboard, emit
 *  `clippity://capture/finished`. */
export function finishFreehandCapture(
  request: FinishFreehandRequest
): Promise<OverlayResult> {
  return invoke<OverlayResult, { request: FinishFreehandRequest }>(
    "finish_freehand_capture",
    { request }
  );
}

/** Finalize a Brush selection — composite the snapshot through the
 *  painted alpha mask, crop to the mask's bbox, save, optional clipboard,
 *  emit `clippity://capture/finished`. */
export function finishBrushCapture(
  request: FinishBrushRequest
): Promise<OverlayResult> {
  return invoke<OverlayResult, { request: FinishBrushRequest }>(
    "finish_brush_capture",
    { request }
  );
}

/** Finalize a Multi-Area selection — crop every rect, stitch on white,
 *  save, optional clipboard, emit `clippity://capture/finished`. */
export function finishMultiAreaCapture(
  request: FinishMultiAreaRequest
): Promise<OverlayResult> {
  return invoke<OverlayResult, { request: FinishMultiAreaRequest }>(
    "finish_multi_area_capture",
    { request }
  );
}

/** Color-Picker mode: sample the pixel at canvas-local physical
 *  `(x, y)`. The backend copies the `#RRGGBB` hex to the clipboard and
 *  surfaces a color toast; the returned `PickedColor` is for any inline
 *  use by the caller. */
export function pickColor(x: number, y: number): Promise<PickedColor> {
  return invoke<PickedColor, { x: number; y: number }>("pick_color", {
    x,
    y,
  });
}

/** Palette-Capture mode: crop the selected `rect` (canvas-local
 *  physical px), quantize to up to `count` colors, persist a `palette`
 *  library entry + show a palette toast. Returns the persisted entry.
 *  Omit `count` (the usual case) to use the configured
 *  `capture.paletteCount` setting — 6 out of the box; the backend clamps
 *  any explicit value to 2–16. */
export function finishPaletteCapture(
  rect: Region,
  count?: number
): Promise<CaptureMeta> {
  return invoke<CaptureMeta, { rect: Region; count: number | null }>(
    "finish_palette_capture",
    { rect, count: count ?? null }
  );
}

/** Grab-Text mode: crop the selected `rect` (canvas-local physical px),
 *  OCR it, copy the text to the clipboard, persist a `text` library
 *  entry + show a text toast. Returns the recognized text; rejects with
 *  an `ocr` error when the region has no readable text. */
export function finishGrabText(rect: Region): Promise<string> {
  return invoke<string, { rect: Region }>("finish_grab_text_capture", {
    rect,
  });
}

/** The last rectangular selection the user captured, in canvas-local
 *  PHYSICAL pixels, resolved against the current virtual desktop.
 *  `null` when nothing has been captured yet or the stored rect no
 *  longer fits on screen. Survives an app restart (the backend persists
 *  it to `last-region.json`).
 *
 *  Divide by `devicePixelRatio` to get the logical-px rect the overlay
 *  draws in — this is the same seam `finishRegionCapture` multiplies at.
 *
 *  Recorded by every rect-shaped capture (Rectangle / Palette /
 *  Grab-Text). Freehand, Pen, and Brush do not update it: their bounding
 *  box isn't the shape the user selected, so repeating it would capture
 *  something they never chose. */
export function lastRegion(): Promise<Region | null> {
  return invoke<Region | null>("last_region");
}

/** One-shot repeat of the last rectangular selection — no overlay, no
 *  drag. Grabs a fresh screenshot, crops the remembered rect, saves,
 *  and emits `clippity://capture/finished` like any other capture.
 *
 *  Rejects when nothing is remembered, or when the virtual desktop has
 *  changed size since the region was stored — nothing is shown for the
 *  user to sanity-check before the shutter fires, so stale coordinates
 *  are an error rather than something to clamp. Use `lastRegion()` +
 *  the overlay restore when the rect should be reviewable first. */
export function recaptureLastRegion(
  toggles: OverlayToggles
): Promise<OverlayResult> {
  return invoke<OverlayResult, { toggles: OverlayToggles }>(
    "recapture_last_region",
    { toggles }
  );
}

/**
 * URI scheme the frozen-desktop snapshot is served over. Must match
 * `SNAPSHOT_SCHEME` in the backend's `lib.rs`.
 */
const SNAPSHOT_SCHEME = "clippity-snapshot";

/** Id of the snapshot the overlay should be showing, or `null` when none
 *  is servable yet (overlay not open, encode still running, or the grab
 *  failed). Pair with {@link desktopSnapshotUrl}. */
export function getDesktopSnapshotId(): Promise<number | null> {
  return invoke<number | null>("get_desktop_snapshot_id");
}

/**
 * Where to load the snapshot's pixels from.
 *
 * An id plus a URL rather than the image itself: a full-desktop PNG is
 * ~8 MiB, and returning it as a base64 data URI meant an 11 MiB string
 * through the JSON IPC bridge, an `atob` on the main thread, and a
 * separate decode for each of the three `url(…)` consumers. Fetched from
 * a URL instead, the bytes never become a JS string and the webview
 * decodes and caches them once for all three.
 *
 * The id is in the path, so each session's URL is distinct and a cached
 * response can never be the previous overlay's desktop.
 */
export function desktopSnapshotUrl(id: number): string {
  return convertFileSrc(String(id), SNAPSHOT_SCHEME);
}

/** Fetch the cached capturable windows for the overlay's Window mode
 *  (front-to-back Z-order, physical-pixel rects). Empty unless the
 *  overlay is currently open in Window mode. The window-selection hook
 *  hit-tests these on pointer-move and finalizes the hovered one on
 *  click. */
export function overlayWindows(): Promise<OverlayWindow[]> {
  return invoke<OverlayWindow[]>("overlay_windows");
}

/** Object mode: run the configured on-device detector over the cached
 *  desktop snapshot. Returns canvas-local physical-pixel boxes. Slow
 *  (one ONNX inference per snapshot tile, ~0.5–2 s) — call once per
 *  overlay session, not per pointer move. Rejects with a `vision`
 *  error when no overlay session is active or the model isn't
 *  installed. */
export function detectObjects(): Promise<DetectedObject[]> {
  return invoke<DetectedObject[]>("detect_objects");
}

// ---------- Event wrappers ----------

export function onOverlayOpening(
  handler: (payload: OverlayOpeningPayload) => void
): () => void {
  return on<OverlayOpeningPayload>(EVENT_NAMES.overlayOpening, handler);
}

/** Subscribe to the `overlay/shown` event. Fired by the backend after
 *  `show_region_overlay` positions + reveals the window. */
export function onOverlayShown(
  handler: (payload: OverlayShownPayload) => void
): () => void {
  return on<OverlayShownPayload>(EVENT_NAMES.overlayShown, handler);
}

/** Subscribe to `overlay/snapshot-ready` — fires when the backend's
 *  background loupe encoder finishes producing the cached data URI.
 *  Decoupled from `overlay/shown` so the overlay UI can become
 *  interactive before the (slow) PNG encode completes; the magnifier
 *  loads its sample canvas on this event. */
export function onOverlaySnapshotReady(handler: () => void): () => void {
  return on<void>(EVENT_NAMES.overlaySnapshotReady, handler);
}

/** Subscribe to the `overlay/toggles` mirror — the capture window
 *  broadcasts its current toggle state so the overlay's bottom bar
 *  reflects what the user pre-set. */
export function onOverlayToggles(
  handler: (payload: Partial<OverlayToggles>) => void
): () => void {
  return on<Partial<OverlayToggles>>(EVENT_NAMES.overlayToggles, handler);
}

/** Capture-window → overlay sync: emit the current toggle state.
 *  Called from `useCaptureWorkflow` on every toggle flip + before
 *  triggering `beginRegionCapture`. */
export async function emitOverlayToggles(
  toggles: OverlayToggles
): Promise<void> {
  await emit(EVENT_NAMES.overlayToggles, toggles);
}
