/**
 * Annotation model helpers — creating them, splitting them into
 * intervals, and turning them into what the backend receives.
 *
 * The interval split is the piece worth reading. An export burns
 * annotations in by compositing a pre-rendered overlay onto each frame,
 * and the naive version of that renders one overlay per frame — tens of
 * thousands of full-resolution bitmaps for a clip of any length.
 *
 * Because an annotation holds one position for its whole range, the
 * picture only changes when one starts or ends. So the boundaries cut
 * the clip into at most `2N+1` spans, the drawn set is constant across
 * each, and one overlay per span is enough. Six annotations need at most
 * thirteen bitmaps for the entire export, and spans where nothing is
 * showing need none at all.
 */

import type {
  Annotation,
  AnnotationKind,
  NormRect,
  Redaction,
} from "@clippity/shared";
import { coversMs, isPixelFilter } from "@clippity/shared";

/** How long a new annotation lasts, before clamping to the clip. */
export const DEFAULT_ANNOTATION_MS = 3_000;

/** Shortest an annotation's range may be dragged. Below about this it
 *  cannot be grabbed again on a timeline of any realistic length. */
export const MIN_ANNOTATION_MS = 100;

/** Where a new annotation lands when it is not drawn onto the picture:
 *  a comfortable box near the middle, big enough to grab. */
const DEFAULT_RECT: NormRect = { x: 0.3, y: 0.35, w: 0.4, h: 0.3 };

/** Default ink. Reads on both light and dark content, which a
 *  screen recording will have both of. */
const DEFAULT_COLOR = "#ff3b30";

/**
 * A span of the clip over which the drawn annotations do not change.
 * One overlay bitmap is rendered per span.
 */
export interface AnnotationInterval {
  startMs: number;
  /** Exclusive. */
  endMs: number;
}

/** Ids are only ever compared, never parsed or ordered. */
function newId(): string {
  return `an_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build an annotation of `kind` with that kind's defaults.
 *
 * One factory rather than a literal at each call site, so a new kind
 * cannot be created somewhere with a field missing — the union would
 * catch a missing field, but not a nonsensical default like a zero
 * stroke width or an empty time range.
 */
export function createAnnotation<K extends AnnotationKind>(
  kind: K,
  startMs: number,
  durationMs: number = DEFAULT_ANNOTATION_MS,
  rect: NormRect = DEFAULT_RECT
): Extract<Annotation, { kind: K }> {
  const base = {
    id: newId(),
    rect,
    startMs,
    endMs: startMs + Math.max(durationMs, MIN_ANNOTATION_MS),
  };
  // The generic return is what lets a caller write
  // `{ ...createAnnotation("text", 0), text: "hi" }` and be checked
  // against `TextAnnotation` rather than against the whole union. Each
  // arm below genuinely returns the variant its `kind` names, which is
  // a fact TypeScript cannot carry through a switch on a generic — hence
  // the one cast, at the boundary rather than at every call site.
  const built = ((): Annotation => {
    switch (kind) {
      case "box":
        return {
          ...base,
          kind,
          color: DEFAULT_COLOR,
          filled: false,
          strokeWidth: 0.006,
        };
      case "spotlight":
        return { ...base, kind, dim: 0.55 };
      case "text":
        return {
          ...base,
          kind,
          text: "Label",
          color: "#ffffff",
          fontScale: 0.05,
        };
      case "arrow":
        return {
          ...base,
          kind,
          color: DEFAULT_COLOR,
          strokeWidth: 0.008,
          fromCorner: "topLeft",
        };
      case "pixelate":
        return { ...base, kind, block: 16 };
      case "blur":
        return { ...base, kind, radius: 8 };
    }
  })();
  return built as Extract<Annotation, { kind: K }>;
}

/** The annotations showing at a moment, in paint order. */
export function activeAt(
  annotations: readonly Annotation[],
  ms: number
): Annotation[] {
  return annotations.filter((a) => coversMs(a, ms));
}

/**
 * Spans of `[fromMs, toMs)` over which the *drawn* annotations are
 * constant and at least one is showing.
 *
 * Pixel-filter annotations are excluded deliberately: they cross to the
 * backend as parameters, so a blur starting halfway through does not
 * need an overlay boundary and would only cost an extra bitmap.
 *
 * Spans with nothing showing are omitted rather than emitted empty — the
 * backend composites nothing for a frame it finds no overlay for, so an
 * empty overlay would be a full-resolution transparent PNG rendered,
 * encoded, staged and alpha-blended to change no pixels.
 */
export function overlayIntervals(
  annotations: readonly Annotation[],
  fromMs: number,
  toMs: number
): AnnotationInterval[] {
  if (toMs <= fromMs) return [];
  const drawn = annotations.filter((a) => !isPixelFilter(a));
  if (drawn.length === 0) return [];

  const inRange = (ms: number) => ms > fromMs && ms < toMs;
  const cuts = new Set<number>([fromMs, toMs]);
  for (const annotation of drawn) {
    if (inRange(annotation.startMs)) cuts.add(annotation.startMs);
    if (inRange(annotation.endMs)) cuts.add(annotation.endMs);
  }

  const ordered = [...cuts].sort((a, b) => a - b);
  const intervals: AnnotationInterval[] = [];
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const startMs = ordered[i]!;
    const endMs = ordered[i + 1]!;
    // The set is constant across the span, so its start decides for all
    // of it.
    if (drawn.some((a) => coversMs(a, startMs))) {
      intervals.push({ startMs, endMs });
    }
  }
  return intervals;
}

/**
 * The pixel-filter annotations, in the shape the backend expects.
 *
 * Mirrors Rust's internally-tagged, flattened `Redaction`: `mode`
 * alongside `block` or `radius`, not nested under it.
 */
export function toRedactions(annotations: readonly Annotation[]): Redaction[] {
  const out: Redaction[] = [];
  for (const annotation of annotations) {
    if (!isPixelFilter(annotation)) continue;
    const span = {
      rect: annotation.rect,
      startMs: annotation.startMs,
      endMs: annotation.endMs,
    };
    out.push(
      annotation.kind === "pixelate"
        ? { ...span, mode: "pixelate", block: annotation.block }
        : { ...span, mode: "blur", radius: annotation.radius }
    );
  }
  return out;
}

/**
 * The topmost annotation at a point, or `null`.
 *
 * Searched back to front so the result matches what the user sees: the
 * last one painted is the one on top, and so the one they mean.
 */
export function hitTest(
  annotations: readonly Annotation[],
  x: number,
  y: number,
  ms: number
): Annotation | null {
  for (let i = annotations.length - 1; i >= 0; i -= 1) {
    const annotation = annotations[i]!;
    if (!coversMs(annotation, ms)) continue;
    const { rect } = annotation;
    if (
      x >= rect.x &&
      x <= rect.x + rect.w &&
      y >= rect.y &&
      y <= rect.y + rect.h
    ) {
      return annotation;
    }
  }
  return null;
}

/** Which end of an annotation's range a gesture is pulling. */
export type AnnotationEdge = "start" | "end";

/**
 * Resolve dragging one end of an annotation's range to `valueMs`.
 *
 * The counterpart of the trim's `resolveHandleDrag`, and it exists for
 * the same reason: every path that changes a range — a drag, a button, a
 * keystroke — goes through one resolver, so none of them can produce a
 * range the others would consider invalid. An inverted or
 * zero-length annotation cannot be grabbed again to fix it.
 *
 * The dragged edge is the one that moves; the other holds, and only
 * gives way to keep [`MIN_ANNOTATION_MS`] between them.
 */
export function resolveAnnotationDrag(
  annotation: Annotation,
  edge: AnnotationEdge,
  valueMs: number,
  durationMs: number
): { startMs: number; endMs: number } {
  const clamp = (ms: number) => Math.min(Math.max(ms, 0), durationMs);

  if (edge === "start") {
    // Never past the out-point's minimum gap, and never so far right
    // that the annotation would leave the clip.
    const startMs = clamp(
      Math.min(
        valueMs,
        annotation.endMs - MIN_ANNOTATION_MS,
        durationMs - MIN_ANNOTATION_MS
      )
    );
    return {
      startMs,
      endMs: Math.max(annotation.endMs, startMs + MIN_ANNOTATION_MS),
    };
  }
  const endMs = clamp(
    Math.max(valueMs, annotation.startMs + MIN_ANNOTATION_MS, MIN_ANNOTATION_MS)
  );
  return {
    startMs: Math.min(annotation.startMs, endMs - MIN_ANNOTATION_MS),
    endMs,
  };
}

/**
 * Slide a whole range by `deltaMs`, keeping its length.
 *
 * Clamps the *position* rather than the length, so dragging an
 * annotation into either end of the clip parks it there instead of
 * squashing it — the same behaviour `moveRect` gives a rectangle pushed
 * against the edge of the frame.
 */
export function moveAnnotationRange(
  annotation: Annotation,
  deltaMs: number,
  durationMs: number
): { startMs: number; endMs: number } {
  const length = annotation.endMs - annotation.startMs;
  const startMs = Math.min(
    Math.max(annotation.startMs + deltaMs, 0),
    Math.max(durationMs - length, 0)
  );
  return { startMs, endMs: startMs + length };
}

/** Clamp a rect to the frame, keeping it at least a sliver in size. */
export function clampRect(rect: NormRect): NormRect {
  const w = Math.min(Math.max(rect.w, 0.01), 1);
  const h = Math.min(Math.max(rect.h, 0.01), 1);
  return {
    w,
    h,
    x: Math.min(Math.max(rect.x, 0), 1 - w),
    y: Math.min(Math.max(rect.y, 0), 1 - h),
  };
}

/**
 * Move a rect by a delta, keeping it on the frame.
 *
 * Clamps the *position* while preserving the size, so dragging an
 * annotation into the edge slides it along rather than squashing it.
 */
export function moveRect(rect: NormRect, dx: number, dy: number): NormRect {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy });
}

/** Which corner of a rect a resize gesture is pulling. */
export type ResizeCorner = "nw" | "ne" | "sw" | "se";

/**
 * Resize a rect by dragging one corner to `(x, y)`.
 *
 * Normalises afterwards, so dragging a corner past its opposite flips
 * the rectangle rather than producing a negative size — which would
 * render mirrored and hit-test as empty.
 */
export function resizeRect(
  rect: NormRect,
  corner: ResizeCorner,
  x: number,
  y: number
): NormRect {
  const left = corner === "nw" || corner === "sw" ? x : rect.x;
  const right = corner === "ne" || corner === "se" ? x : rect.x + rect.w;
  const top = corner === "nw" || corner === "ne" ? y : rect.y;
  const bottom = corner === "sw" || corner === "se" ? y : rect.y + rect.h;

  return clampRect({
    x: Math.min(left, right),
    y: Math.min(top, bottom),
    w: Math.abs(right - left),
    h: Math.abs(bottom - top),
  });
}
