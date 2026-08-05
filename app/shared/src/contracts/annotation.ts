/**
 * Studio annotations — a shape, a rectangle and a time range.
 *
 * Mirrors Rust `domain::annotation`, but only partly, and the asymmetry
 * is the point. Most of an annotation never reaches Rust at all.
 *
 * Boxes, spotlights, text and arrows are *drawn*, and they are drawn by
 * exactly one function — the same canvas code renders the live preview
 * and, at the source's native resolution, the overlay bitmaps the export
 * composites. That is the property the editor's `flattenScene` has, and
 * it is why a callout on screen and a callout in the exported file
 * cannot disagree: there is only one renderer to be wrong. So the
 * backend never learns what a "text callout" is. It receives a PNG.
 *
 * Blur and pixelation are the exception, because they transform the
 * pixels *underneath* rather than painting over them, and the webview
 * does not have the decoded frame. Those two cross as parameters and are
 * implemented on both sides — see {@link Redaction}, and the note there
 * about what keeps the two implementations honest.
 */

/**
 * A rectangle in fractions of the frame, `0..1`.
 *
 * Normalised rather than in pixels so an annotation survives being drawn
 * at a different size: the preview draws at whatever the stage is
 * showing, the export at native resolution, and a GIF at a third size
 * again. Pixels would tie a saved sidecar to the display it was authored
 * on.
 */
export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fields every annotation has, whatever it draws. */
interface AnnotationBase {
  /** Stable across edits; identifies the selection and the sidecar entry. */
  id: string;
  rect: NormRect;
  startMs: number;
  /** Exclusive, matching the trim range's convention — two adjacent
   *  annotations tile without a frame belonging to both. */
  endMs: number;
}

/**
 * A rectangle, outlined or filled.
 *
 * A *filled* box is the redaction that actually redacts. Blur and
 * pixelation are the familiar choice and are offered, but both have been
 * shown to be reversible on text often enough that a solid cover is the
 * one to reach for when it genuinely matters.
 */
export interface BoxAnnotation extends AnnotationBase {
  kind: "box";
  color: string;
  filled: boolean;
  /** In fractions of the frame *height* — see {@link TextAnnotation.fontScale}
   *  for why every size in this file is relative rather than in pixels. */
  strokeWidth: number;
}

/** Dims everything *outside* the rectangle, to point at what is inside. */
export interface SpotlightAnnotation extends AnnotationBase {
  kind: "spotlight";
  /** `0..1` — how far the surrounding frame is darkened. */
  dim: number;
}

/** A text label. Laid out inside the rectangle, wrapping to it. */
export interface TextAnnotation extends AnnotationBase {
  kind: "text";
  text: string;
  color: string;
  /** In fractions of the frame *height*, so text keeps its size relative
   *  to the picture at any render scale — a point size would shrink to
   *  nothing on the export of a 5120-wide capture. */
  fontScale: number;
}

/**
 * An arrow, drawn corner to corner across its rectangle.
 *
 * Deliberately carries no separate endpoints. Reusing `rect` means an
 * arrow drags, resizes and hit-tests through exactly the same code as
 * every other annotation, and the only thing the renderer needs to know
 * is which diagonal to draw along.
 */
export interface ArrowAnnotation extends AnnotationBase {
  kind: "arrow";
  color: string;
  /** In fractions of the frame height, as {@link BoxAnnotation.strokeWidth}. */
  strokeWidth: number;
  /** Which way the head points along the rect's diagonal. */
  fromCorner: "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
}

/** Averages each `block`×`block` cell of the frame into one colour. */
export interface PixelateAnnotation extends AnnotationBase {
  kind: "pixelate";
  /** In **source** pixels. See the note on scale in `domain::annotation`. */
  block: number;
}

/** Three passes of a box average — see {@link Redaction}. */
export interface BlurAnnotation extends AnnotationBase {
  kind: "blur";
  /** In **source** pixels. */
  radius: number;
}

export type Annotation =
  | BoxAnnotation
  | SpotlightAnnotation
  | TextAnnotation
  | ArrowAnnotation
  | PixelateAnnotation
  | BlurAnnotation;

export type AnnotationKind = Annotation["kind"];

/** The kinds that transform the pixels under them instead of painting
 *  over them, and therefore cannot be pre-rendered into an overlay. */
export type PixelFilterAnnotation = PixelateAnnotation | BlurAnnotation;

/**
 * Whether an annotation has to be burned in by the backend rather than
 * drawn into an overlay.
 *
 * The single place that split is decided. Both the export path (which
 * partitions annotations into overlays and redactions) and the preview
 * (which draws one set on a canvas and applies the other to the frame's
 * pixels) ask this, so the two cannot come to different conclusions
 * about what a given annotation is.
 */
export function isPixelFilter(
  annotation: Annotation,
): annotation is PixelFilterAnnotation {
  return annotation.kind === "pixelate" || annotation.kind === "blur";
}

/** Whether an annotation covers a moment. Half-open, as `endMs` says. */
export function coversMs(annotation: Annotation, ms: number): boolean {
  return ms >= annotation.startMs && ms < annotation.endMs;
}

// ---------- wire types ----------

/**
 * A pixel-filter annotation as the backend receives it.
 *
 * Mirrors Rust `domain::annotation::Redaction`, whose `mode` is an
 * internally-tagged enum flattened into the struct — so `block` and
 * `radius` sit alongside `mode` rather than nested under it. The Rust
 * side pins this shape with a test, because a mismatch here does not
 * fail loudly: the redaction simply stops deserializing, and therefore
 * stops being applied, on an export that otherwise succeeds.
 *
 * The two implementations of these filters are kept honest by a shared
 * fixture rather than by inspection — see `lib/redact.ts`.
 */
export type Redaction = {
  rect: NormRect;
  startMs: number;
  endMs: number;
} & ({ mode: "pixelate"; block: number } | { mode: "blur"; radius: number });

/**
 * One staged overlay bitmap and the span of the clip it covers.
 *
 * There is one of these per interval between annotation boundaries — not
 * one per frame — which is what keeps a whole clip's worth of overlays
 * down to a handful of files.
 */
export interface OverlayRef {
  /** Absolute path of the staged PNG, from `media_stage_overlay`. */
  path: string;
  startMs: number;
  /** Exclusive. */
  endMs: number;
}
