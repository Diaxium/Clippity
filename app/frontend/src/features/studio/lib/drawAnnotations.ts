/**
 * The one renderer.
 *
 * Every drawn annotation — boxes, spotlights, text, arrows — is painted
 * by this file and only this file. The live preview calls it against a
 * canvas sized to the stage; the export calls it against a canvas sized
 * to the source's native resolution and encodes the result as an overlay
 * PNG for the backend to composite.
 *
 * That is the whole reason the burn-in was split the way it was. The
 * editor's `flattenScene` has the same property, and it is what makes a
 * callout on screen and a callout in the exported file the same thing
 * rather than two things that agree until they don't. A second
 * implementation in Rust would have meant matching font metrics,
 * arrowhead geometry and antialiasing across two rasterisers — and
 * failing invisibly, in a file the user only opens later.
 *
 * The blur and pixelate kinds are absent here on purpose: they transform
 * the pixels underneath rather than painting over them, so they cannot
 * be pre-rendered into an overlay at all. They live in `redact.ts`, are
 * implemented twice, and are pinned by a cross-language fixture.
 *
 * ## Every size is relative
 *
 * Stroke widths and font sizes are fractions of the frame **height**,
 * never pixels. The same annotation is drawn at stage size and again at
 * up to 5120 px wide, and a value in pixels would render a readable
 * label on the preview and an illegible speck on the export.
 */

import type {
  Annotation,
  ArrowAnnotation,
  BoxAnnotation,
  NormRect,
  SpotlightAnnotation,
  TextAnnotation,
} from "@clippity/shared";
import { coversMs, isPixelFilter } from "@clippity/shared";

/**
 * Font stack for text callouts.
 *
 * Preview and export run in the same webview, so whatever this resolves
 * to resolves the same way for both — which is the property that matters
 * here, more than which face wins.
 */
const FONT_STACK =
  '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

/** Padding inside a text annotation's box, as a fraction of its height. */
const TEXT_PADDING = 0.12;

/** Line height as a multiple of the font size. */
const LINE_HEIGHT = 1.25;

/** Arrowhead length as a multiple of the stroke width. */
const HEAD_LENGTH = 3.2;

/** A rectangle in the pixels of whatever we are drawing into. */
export interface DrawRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Resolve a normalised rect against the target size. */
export function toDrawRect(
  rect: NormRect,
  width: number,
  height: number
): DrawRect {
  return {
    x: rect.x * width,
    y: rect.y * height,
    w: rect.w * width,
    h: rect.h * height,
  };
}

/**
 * The four bands that dim everything outside a spotlight's rectangle.
 *
 * Drawn as four solid rectangles rather than by punching a hole with a
 * compositing mode, which would erase whatever had already been drawn
 * inside the rect. Four bands are order-independent: a spotlight cannot
 * damage an annotation beneath it.
 *
 * Exported for its test — the arithmetic is trivial and the failure is
 * not, since a band that is one pixel short leaves a bright seam down
 * the edge of every spotlight.
 */
export function spotlightBands(
  rect: DrawRect,
  width: number,
  height: number
): DrawRect[] {
  // Clamp so a rect dragged off the frame cannot produce negative bands,
  // which fillRect would silently draw mirrored.
  const left = Math.max(0, Math.min(rect.x, width));
  const top = Math.max(0, Math.min(rect.y, height));
  const right = Math.max(left, Math.min(rect.x + rect.w, width));
  const bottom = Math.max(top, Math.min(rect.y + rect.h, height));

  return [
    { x: 0, y: 0, w: width, h: top },
    { x: 0, y: bottom, w: width, h: height - bottom },
    { x: 0, y: top, w: left, h: bottom - top },
    { x: right, y: top, w: width - right, h: bottom - top },
  ].filter((band) => band.w > 0 && band.h > 0);
}

/**
 * Start and end of an arrow, along the diagonal its corner names.
 *
 * The arrow reuses `rect` rather than carrying its own endpoints, so it
 * drags, resizes and hit-tests through the same code as every other
 * annotation. This is the only place that knows which diagonal that
 * means.
 */
export function arrowPoints(
  rect: DrawRect,
  fromCorner: ArrowAnnotation["fromCorner"]
): { fromX: number; fromY: number; toX: number; toY: number } {
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;

  switch (fromCorner) {
    case "topLeft":
      return { fromX: left, fromY: top, toX: right, toY: bottom };
    case "topRight":
      return { fromX: right, fromY: top, toX: left, toY: bottom };
    case "bottomLeft":
      return { fromX: left, fromY: bottom, toX: right, toY: top };
    case "bottomRight":
      return { fromX: right, fromY: bottom, toX: left, toY: top };
  }
}

/**
 * Break `text` into lines that fit `maxWidth`.
 *
 * Takes a measuring function rather than a context so the wrap can be
 * tested without a real canvas — jsdom does not implement text metrics,
 * and the wrap is the part worth testing.
 *
 * A single word longer than the line is left to overflow rather than
 * broken mid-word: a label is short by nature, and hyphenating one at an
 * arbitrary character reads as corruption.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (s: string) => number
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = words[0]!;
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Draw every annotation covering `ms` onto `ctx`, at the given size.
 *
 * **Clears the target first.** Both callers want exactly the annotations
 * for one moment and nothing left over from the last one, and doing it
 * here rather than at each call site is what guarantees the preview and
 * the export start from the same blank slate.
 *
 * Painted in array order, so a later annotation covers an earlier one —
 * the same last-writer rule the redactions follow.
 */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: readonly Annotation[],
  ms: number,
  width: number,
  height: number
): void {
  ctx.clearRect(0, 0, width, height);

  for (const annotation of annotations) {
    // Blur and pixelate are not drawn — see the module note.
    if (isPixelFilter(annotation) || !coversMs(annotation, ms)) continue;

    const rect = toDrawRect(annotation.rect, width, height);
    ctx.save();
    switch (annotation.kind) {
      case "box":
        drawBox(ctx, annotation, rect, height);
        break;
      case "spotlight":
        drawSpotlight(ctx, annotation, rect, width, height);
        break;
      case "text":
        drawText(ctx, annotation, rect, height);
        break;
      case "arrow":
        drawArrow(ctx, annotation, rect, height);
        break;
    }
    ctx.restore();
  }
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  annotation: BoxAnnotation,
  rect: DrawRect,
  height: number
): void {
  if (annotation.filled) {
    // The redaction that actually redacts: a solid cover, with no
    // recoverable signal under it.
    ctx.fillStyle = annotation.color;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    return;
  }
  const stroke = Math.max(annotation.strokeWidth * height, 1);
  ctx.strokeStyle = annotation.color;
  ctx.lineWidth = stroke;
  // Inset by half the stroke so the outline sits inside the rectangle
  // the user drew, rather than straddling it — otherwise a box on the
  // edge of the frame loses half its border off-screen.
  ctx.strokeRect(
    rect.x + stroke / 2,
    rect.y + stroke / 2,
    Math.max(rect.w - stroke, 0),
    Math.max(rect.h - stroke, 0)
  );
}

function drawSpotlight(
  ctx: CanvasRenderingContext2D,
  annotation: SpotlightAnnotation,
  rect: DrawRect,
  width: number,
  height: number
): void {
  const dim = Math.min(Math.max(annotation.dim, 0), 1);
  if (dim <= 0) return;
  ctx.fillStyle = `rgba(0, 0, 0, ${dim})`;
  for (const band of spotlightBands(rect, width, height)) {
    ctx.fillRect(band.x, band.y, band.w, band.h);
  }
}

function drawText(
  ctx: CanvasRenderingContext2D,
  annotation: TextAnnotation,
  rect: DrawRect,
  height: number
): void {
  const fontPx = Math.max(annotation.fontScale * height, 1);
  ctx.font = `${fontPx}px ${FONT_STACK}`;
  ctx.fillStyle = annotation.color;
  ctx.textBaseline = "top";

  const pad = rect.h * TEXT_PADDING;
  const lines = wrapText(
    annotation.text,
    Math.max(rect.w - pad * 2, 1),
    (s) => ctx.measureText(s).width
  );

  // Clip to the box so a label longer than its rectangle is cut off at
  // the edge the user drew rather than running across the picture.
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();

  let y = rect.y + pad;
  for (const line of lines) {
    ctx.fillText(line, rect.x + pad, y);
    y += fontPx * LINE_HEIGHT;
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  annotation: ArrowAnnotation,
  rect: DrawRect,
  height: number
): void {
  const stroke = Math.max(annotation.strokeWidth * height, 1);
  const { fromX, fromY, toX, toY } = arrowPoints(rect, annotation.fromCorner);
  const angle = Math.atan2(toY - fromY, toX - fromX);
  const head = stroke * HEAD_LENGTH;

  ctx.strokeStyle = annotation.color;
  ctx.fillStyle = annotation.color;
  ctx.lineWidth = stroke;
  ctx.lineCap = "round";

  // Stop the shaft short of the tip so the stroke's round cap does not
  // poke out through the head.
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(
    toX - Math.cos(angle) * head * 0.8,
    toY - Math.sin(angle) * head * 0.8
  );
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - Math.cos(angle - Math.PI / 7) * head,
    toY - Math.sin(angle - Math.PI / 7) * head
  );
  ctx.lineTo(
    toX - Math.cos(angle + Math.PI / 7) * head,
    toY - Math.sin(angle + Math.PI / 7) * head
  );
  ctx.closePath();
  ctx.fill();
}
