/**
 * Recorder sources — mirror Rust `domain::composition` (ADR 0033).
 *
 * A source is something composited **over** the captured frame: a
 * webcam, a logo. It does not build a canvas of its own — the
 * recording's geometry stays whatever the user pointed at, and a source
 * is drawn into it at a normalized position.
 */

// `NormRect` is `annotation`'s, reused rather than re-declared — the
// same call the Rust side makes (ADR 0033). A source's position is the
// same idea as an annotation's: a rectangle as a fraction of the frame,
// so it survives a change of frame size. Two of them in one contract
// package would be two things to keep in agreement.
import type { NormRect } from "./annotation";

/** What a source draws. Tagged by `kind` on the wire — the Rust enum is
 *  internally tagged with the payload flattened alongside it. */
export type SourceKind =
  | { kind: "webcam"; deviceId?: string | null }
  | { kind: "image"; path: string };

/**
 * One thing composited over the recording, and where.
 *
 * **Order is meaningful**: later sources draw over earlier ones, so two
 * overlapping sources have a defined result rather than one that depends
 * on iteration order.
 */
export type Source = SourceKind & {
  rect: NormRect;
  /** 0–100, scaling the source's own alpha. Omitted = 100. */
  opacityPct?: number;
  /** A disabled source is skipped without being forgotten — it keeps its
   *  position, so turning a webcam off for one recording does not cost
   *  the user the corner they placed it in. Omitted = true. */
  enabled?: boolean;
};

/** Most sources one recording may carry. Mirrors
 *  `domain::composition::MAX_SOURCES` — a bound on nonsense rather than
 *  a technical limit. */
export const MAX_SOURCES = 8;

/** A camera offered by the backend for the sources UI. An empty list is
 *  a valid answer: a machine with no camera is a configuration. */
export interface WebcamDeviceInfo {
  id: string;
  name: string;
}
