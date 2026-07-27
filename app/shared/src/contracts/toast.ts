/**
 * Toast wire-format contracts — mirror Rust `domain::toast`.
 *
 * **MVP scope**: only the `error` variant is reachable. The reserved
 * variants exist for wire-shape stability — each owning port flips its
 * variant from "reserved" to "armable" when it lands.
 */

/** Sampled colour — reserved for Color-Pick custom mode. */
export interface PickedColor {
  r: number;
  g: number;
  b: number;
  hex: string;
}

/** Palette swatch — reserved for Palette-Capture custom mode. */
export interface PaletteSwatch {
  r: number;
  g: number;
  b: number;
  hex: string;
  /** Share of the sampled region (0–1, dominant first). Drives the
   *  toast's proportional swatch widths + percentage labels. */
  proportion?: number;
}

/** Recording style — reserved for the recording-engine port. */
export type RecordingMode = "scrolling" | "panoramic";

/** Which output a running recorder session is producing (ADR 0031). */
export type RecorderToastFormat = "mp4" | "gif";

/**
 * Toast payload — discriminated on `kind`, kebab-case end-to-end.
 *
 * **Only `error` is reachable through `showToast` in MVP.** The other
 * variants are typed here so a future port can flip its body armable
 * without breaking the wire shape.
 */
export type ToastPayload =
  | { kind: "error"; message: string }
  | {
      kind: "clipboard";
      preview: string;
      width: number;
      height: number;
      /** Original plaintext, present only when the clipboard held text. */
      text?: string;
    }
  | { kind: "color"; color: PickedColor }
  | { kind: "palette"; preview: string; colors: PaletteSwatch[] }
  | { kind: "text"; text: string }
  | { kind: "recording"; mode: RecordingMode; frames: number }
  /**
   * The video/GIF recorder HUD. Distinct from `recording`, which is the
   * scroll stitcher's: that one counts frames toward a still image and
   * offers Stop & Stitch, this one runs a clock and offers
   * pause/resume. Always sticky — it is the only way to stop a session.
   */
  | { kind: "recorder"; format: RecorderToastFormat; audio: boolean };

/** Convenience extractor — the discriminant. */
export type ToastKind = ToastPayload["kind"];

/** Per-kind auto-dismiss timeouts in milliseconds. `0` = sticky. */
export interface ToastDurations {
  color: number;
  palette: number;
  clipboard: number;
  text: number;
  recording: number;
  error: number;
}

/** Anchor corner of the cursor's monitor's work area. */
export type ToastCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

/**
 * Wire shape of `clippity://toast/show`. The Rust event-emitter
 * flattens the discriminated payload into the outer object so this
 * is a single intersection on the TS side.
 */
export type ToastShowEvent = ToastPayload & { durationMs: number };
