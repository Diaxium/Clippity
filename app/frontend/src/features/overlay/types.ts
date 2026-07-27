/**
 * Public types for the overlay feature.
 *
 * Wire-format types (`OverlayMode`, `Region`, `OverlayToggles`, …)
 * live in `@services/tauri/clients/overlay` per ADR 0001. This file
 * re-exports them so intra-feature imports stay short and adds the
 * UI-only shapes the components / hooks consume.
 */

// Re-export wire types — single source of truth.
export type {
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
  BrushMask,
  OverlayResult,
  OverlayOpeningPayload,
  OverlayShownPayload,
} from "@services/tauri/clients/overlay";

// ---- UI-only types -------------------------------------------------

/** Logical-pixel screen point (CSS px, before DPR scaling). */
export interface Pt {
  x: number;
  y: number;
}

/** One Pen / Bézier-path anchor. `p` is the on-path point; `hIn` /
 *  `hOut` are the ABSOLUTE positions of the incoming / outgoing control
 *  handles (logical px), or `null` for a hard corner with no curve on
 *  that side. Symmetric drags keep `hIn` mirrored across `p`; Alt breaks
 *  the symmetry. Flattened to a polygon at finalize via `flattenBezier`. */
export interface PenAnchor {
  p: Pt;
  hIn: Pt | null;
  hOut: Pt | null;
}

/** Logical-pixel rectangle. Frontend works in logical px throughout
 *  — coords get multiplied by `devicePixelRatio` only at the IPC seam
 *  (see `finishRegionCapture`). */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Region-mode interaction phase. The state machine starts at
 *  `empty` (no cursor activity), advances to `idle` on pointer-move
 *  (crosshair + loupe visible), `dragging` on pointer-down, and
 *  `selected` on pointer-up with a valid rect (handles + grid). */
export type Phase = "empty" | "idle" | "dragging" | "selected";

/** Eight resize-handle directions — corners + edge midpoints. */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Brush paint mode — add to or subtract from the painted mask. */
export type BrushMode = "add" | "subtract";

/** Mode-aware top-banner copy keyed by `(mode, phase)`. The strategy
 *  table in `modes.ts` returns one of these. */
export interface BannerCopy {
  primary: string;
  /** Optional kbd hint shown to the right of primary text. */
  shortcut?: string;
}

/** Object-mode detection lifecycle. `detecting` while the backend's
 *  inference call is in flight; `ready` once boxes have landed (possibly
 *  zero); `error` carries a message rendered in the status pill. */
export type ObjectsStatus = "idle" | "detecting" | "ready" | "error";
