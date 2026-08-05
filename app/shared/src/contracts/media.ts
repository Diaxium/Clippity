/**
 * Studio media contracts — mirror Rust `domain::media`.
 *
 * Studio is to a recording what the editor is to a screenshot. The
 * contracts differ in one structural way, and it explains the shape of
 * everything here: the editor's `EditorImage` carries the *pixels*, as a
 * base64 data URI. This carries no bytes at all.
 *
 * A recording is orders of magnitude larger than a screenshot, and a
 * `<video>` element does not want to be handed one — it wants to seek
 * into it, asking for the byte ranges around the playhead as the user
 * scrubs. So the media travels over the `clippity-media` URI scheme
 * instead, and IPC carries only the description needed to draw a
 * timeline before the first frame decodes.
 *
 * Distinct from `recorder.ts` on purpose: that describes a session that
 * *produces* a file, this describes a file that already exists. They
 * meet at `RecorderFormat`, which is imported rather than restated —
 * a trim is encoded by the very same sinks a recording is.
 */

import type { OverlayRef, Redaction } from "./annotation";
import type { RecorderFormat } from "./recorder";

/**
 * Handle the webview fetches a clip's bytes with.
 *
 * Not a path and not a URL. `media_probe` mints one only after
 * validating the capture id against the captures directory, so the
 * token *is* the proof that the check passed — which is what lets the
 * scheme handler serve bytes without re-deriving whether it may. The
 * frontend turns it into a URL through Tauri's `convertFileSrc`, the
 * same split the overlay's snapshot id uses.
 *
 * Monotonic and never reused, so a stale URL left in the webview's
 * cache resolves to a 404 rather than to some other clip.
 */
export type MediaToken = number;

/**
 * What Studio learns about a clip when it opens it.
 *
 * Read once, from the container's headers — never by decoding — which
 * is why a two-hour recording opens as fast as a two-second one.
 */
export interface MediaInfo {
  /** Capture id (absolute path) this describes. */
  id: string;
  token: MediaToken;
  width: number;
  height: number;
  durationMs: number;
  /**
   * Nominal frame rate. Never zero: when a container declines to state
   * one the backend substitutes an assumed rate, because every
   * frame-stepping calculation in the transport divides by this.
   */
  fps: number;
  /** Whether the file carries an audio track. Drives whether the
   *  transport shows a volume control, and whether a trim decodes
   *  audio at all. */
  hasAudio: boolean;
}

/** Payload sent to `media_trim`. */
export interface TrimRequest {
  /** Capture id of the source clip. */
  id: string;
  /** In-point, milliseconds from the start of the source. */
  startMs: number;
  /**
   * Out-point, milliseconds from the start of the source. Exclusive —
   * the exported clip is `[start, end)`, so `end - start` is exactly
   * its duration and two adjacent trims tile without overlapping.
   */
  endMs: number;
  format: RecorderFormat;
  /** Omit for the source's rate (MP4) or the format default (GIF).
   *  Out-of-range values are clamped by the backend, not rejected. */
  fps?: number | null;
  /** Drop the audio track even though the source has one. Ignored for
   *  GIF, which has nowhere to put it. */
  mute: boolean;
  /**
   * Pixel-filter annotations to burn in, timed against the **source**
   * clip rather than the output. The user set them on the source's
   * timeline, so a trim starting at 0:30 must still find them there —
   * rebasing would shift every annotation by the in-point.
   *
   * Optional on the wire: Rust defaults both of these, so a caller with
   * nothing to burn in sends an ordinary trim request.
   */
  redactions?: Redaction[];
  /** Staged overlay bitmaps to composite, on the same source timeline. */
  overlays?: OverlayRef[];
}

/**
 * Progress of a running trim, carried on `clippity://media/trim-progress`.
 *
 * Encoded-milliseconds rather than a percentage, so the UI can show a
 * real position against the same timeline the user set the handles on —
 * and a percentage can still be derived from the pair.
 */
export interface TrimProgress {
  encodedMs: number;
  totalMs: number;
}

/** What a finished trim produced. */
export interface TrimResult {
  /**
   * Absolute path of the new clip. A trim never writes over its source
   * — the same non-destructive rule the editor's scene sidecar follows,
   * and for the same reason: the original frames are of a moment that
   * cannot be re-recorded.
   */
  path: string;
  format: RecorderFormat;
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}
