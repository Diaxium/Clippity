/**
 * Scroll / panoramic recording wire-format contracts — mirror Rust
 * `domain::scroll`.
 */

/**
 * Scroll/stitch direction for a Scrolling or Panoramic capture — sets
 * the stitch axis and, for Panoramic, which way the app auto-scrolls.
 * Mirrors Rust `domain::scroll::ScrollDirection` (kebab-case wire).
 */
export type ScrollDirection = "down" | "up" | "left" | "right";

/** Worker emits this each time a new (non-duplicate) frame is appended. */
export interface RecordingTick {
  frames: number;
}

/** Throttled live stitch preview (base64 PNG data URI). */
export interface RecordingPreview {
  dataUri: string;
}
