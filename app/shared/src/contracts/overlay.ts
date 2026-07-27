/**
 * Overlay wire-format contracts — mirror Rust `domain::overlay`.
 */

/** What the user is doing inside the overlay. Wire enum kept in
 *  lock-step with the Rust `OverlayMode` so wire shape doesn't change
 *  when reserved variants land. `region` + `window` are reachable; the
 *  rest unblock with their respective ports. */
export type OverlayMode =
  | "region"
  | "window"
  | "color-pick"
  | "freehand"
  | "pen"
  | "magnetic-lasso"
  | "brush"
  | "multi-area"
  | "object"
  | "grab-text"
  | "palette"
  | "scrolling"
  | "panoramic"
  /** Drag a rectangle, then record it (ADR 0031). Shares the whole
   *  Region interaction and diverges only at finalize. */
  | "record-region"
  /** Hover a window, click to record it. The recording counterpart to
   *  `window`, sharing its enumeration and highlight. */
  | "record-window";

/** Physical-pixel rectangle, virtual-desktop-origin coords.
 *  Frontend multiplies by `devicePixelRatio` at this seam. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A capturable top-level window surfaced to the overlay's Window
 *  mode. `rect` is already physical-pixel, virtual-desktop-origin. */
export interface OverlayWindow {
  id: number;
  title: string;
  app: string;
  rect: Region;
}

/** One AI-detected object — Object mode's click targets. `rect` is
 *  physical-pixel, virtual-desktop-origin. `confidence` is the
 *  detector's 0–1 score. */
export interface DetectedObject {
  rect: Region;
  label: string;
  confidence: number;
}

/** Capture-window toggles mirrored to the overlay's bottom bar. */
export interface OverlayToggles {
  preview: boolean;
  clipboard: boolean;
  cursor: boolean;
  /** Run the backend's Smart-enhance pass (auto-levels + a light
   *  unsharp mask) over the cropped pixels before they're encoded. */
  enhance: boolean;
}

/** Sent on `begin_region_capture`. */
export interface BeginOverlayRequest {
  mode: OverlayMode;
  /** Optional per-preset save-dir override threaded into the overlay
   *  session, consumed at finalize. Omitted / null = the live captures
   *  dir. Mirrors Rust `output_dir`. */
  outputDir?: string | null;
  /** Name of the preset that opened the overlay, recorded in the
   *  capture's provenance sidecar. Omitted / null = the user opened it. */
  preset?: string | null;
}

/** Sent on `finish_region_capture`. `cursorPin` is the user's
 *  `lastInSelection` — the canvas-local pixel where the cursor should
 *  land in the crop instead of the live system-cursor position. */
export interface FinishRegionRequest {
  rect: Region;
  cursorPin: [number, number] | null;
  toggles: OverlayToggles;
}

/** Sent on `finish_freehand_capture`. `points` are the lasso path in
 *  canvas-local PHYSICAL pixels (DPR already applied), in draw order. */
export interface FinishFreehandRequest {
  points: [number, number][];
  cursorPin: [number, number] | null;
  toggles: OverlayToggles;
}

/** A painted brush selection. `x`/`y` are the mask bounding box's
 *  canvas-local PHYSICAL-pixel top-left; `rle` is the row-major 8-bit
 *  alpha coverage run-length-encoded as `[value, runLength]` pairs whose
 *  lengths sum to `width * height`. */
export interface BrushMask {
  x: number;
  y: number;
  width: number;
  height: number;
  rle: [number, number][];
}

/** Sent on `finish_brush_capture`. */
export interface FinishBrushRequest {
  mask: BrushMask;
  cursorPin: [number, number] | null;
  toggles: OverlayToggles;
}

/** Sent on `finish_multi_area_capture`. Each rect is canvas-local
 *  physical pixels; the backend stitches the crops horizontally. */
export interface FinishMultiAreaRequest {
  rects: Region[];
  cursorPin: [number, number] | null;
  toggles: OverlayToggles;
}

/** Result of a finalized Region capture. Same shape as `CaptureResult`
 *  re-emitted via `clippity://capture/finished` except `customMode` is
 *  absent here. */
export interface OverlayResult {
  id: string;
  width: number;
  height: number;
  path: string;
  /** Mirrors `CaptureResult.preview` — whether to open the result in
   *  the editor (sourced from the finalize toggles / scroll session). */
  preview: boolean;
}

/** Payload of `clippity://overlay/shown` — fired when the backend
 *  finishes positioning + showing the overlay window. */
export interface OverlayOpeningPayload {
  mode: OverlayMode;
  cursorPosition: [number, number] | null;
}

export interface OverlayShownPayload {
  snapshotOk: boolean;
  mode: OverlayMode;
}
