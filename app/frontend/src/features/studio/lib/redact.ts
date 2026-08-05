/**
 * The preview's half of the two redaction filters.
 *
 * Every other annotation Studio draws exists once, as canvas code shared
 * by the preview and the export — see `drawAnnotations`. These two
 * cannot be, because a blur or a pixelation transforms the pixels
 * *underneath* rather than painting over them, and the webview has no
 * decoded frame to hand the backend. So the export applies them in Rust
 * (`domain::annotation`) and this file applies them to the preview, and
 * for the only time in the feature the same operation is written twice.
 *
 * Two implementations of the same thing drift. What stops it here is not
 * care, it is `redact.test.ts`: both sides run a checked-in fixture —
 * the same input pixels, the same parameters — and assert the same
 * output bytes. If either implementation changes, that test fails on
 * whichever side did not change.
 *
 * So the rules below are stated as exact integer operations rather than
 * as "a blur", and every one of them is load-bearing:
 *
 * - Pixelation averages a grid **anchored at the rect's top-left**, not
 *   at the frame's origin, so the block pattern does not crawl under a
 *   rectangle being dragged.
 * - Blur is {@link BLUR_PASSES} passes of a separable box average rather
 *   than a Gaussian, whose float kernel weights would have to round
 *   identically in two languages.
 * - Both round with {@link roundDiv}, halves up.
 * - Both clamp sampling to the rect, so a redaction neither leaks a
 *   blurred trace of what it hides into the border nor pulls the
 *   surroundings in.
 *
 * ## Scale
 *
 * `block` and `radius` are in **source** pixels. The preview runs on a
 * frame scaled to the stage, with the sizes scaled to match, so its
 * blocks do not land on the same grid the export's will. That is a
 * property of showing a scaled picture, not a defect — the preview shows
 * the operation, and the fixture pins the operation.
 */

import type { Annotation, NormRect } from "@clippity/shared";
import { coversMs, isPixelFilter } from "@clippity/shared";

/** Passes of box average standing in for a Gaussian. Mirrors Rust. */
export const BLUR_PASSES = 3;

/** Smallest block that actually redacts. A block of 1 is the identity
 *  and 2 leaves text legible. Mirrors Rust's `MIN_PIXELATE_BLOCK`. */
export const MIN_PIXELATE_BLOCK = 3;

/** A rectangle resolved onto a frame: inside it, and at least 1×1. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Resolve a normalised rect against a frame size, clamped to it.
 *
 * `null` for a rectangle that covers no pixels — a half-finished drag,
 * which callers treat as nothing to do. Mirrors `NormRect::to_pixels`,
 * including the floor/ceil pairing: resolving the edges before clamping
 * is what keeps the on-frame part of a rectangle that hangs off it.
 */
export function normToPixels(
  rect: NormRect,
  frameW: number,
  frameH: number
): PixelRect | null {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.w) ||
    !Number.isFinite(rect.h) ||
    frameW <= 0 ||
    frameH <= 0
  ) {
    return null;
  }
  const left = Math.max(Math.floor(rect.x * frameW), 0);
  const top = Math.max(Math.floor(rect.y * frameH), 0);
  const right = Math.min(
    Math.max(Math.ceil((rect.x + rect.w) * frameW), 0),
    frameW
  );
  const bottom = Math.min(
    Math.max(Math.ceil((rect.y + rect.h) * frameH), 0),
    frameH
  );

  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Integer mean, rounding halves up.
 *
 * The single arithmetic decision that has to match Rust's `round_div`.
 * Truncating instead — or dividing as floats and flooring — lands a
 * channel one value off on roughly half the blocks of an image, which
 * the fixture catches and an eye never would.
 */
export function roundDiv(sum: number, n: number): number {
  if (n === 0) return 0;
  return Math.floor((sum + Math.floor(n / 2)) / n);
}

/**
 * Average each block of a grid anchored at the rect's top-left and fill
 * the block with it.
 *
 * Mutates `data` in place. Blocks at the right and bottom edges are
 * clipped by the rect and average over the smaller area, so the whole
 * rectangle is covered — a tail block left unwritten is a stripe of the
 * redaction still showing. Alpha is untouched: a redaction that changed
 * transparency would be a hole rather than a cover-up.
 */
export function pixelate(
  data: Uint8ClampedArray,
  frameW: number,
  rect: PixelRect,
  block: number
): void {
  const size = Math.max(block, MIN_PIXELATE_BLOCK);
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;

  for (let top = rect.y; top < bottom; top += size) {
    const cellH = Math.min(size, bottom - top);
    for (let left = rect.x; left < right; left += size) {
      const cellW = Math.min(size, right - left);

      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = top; y < top + cellH; y += 1) {
        for (let x = left; x < left + cellW; x += 1) {
          const i = (y * frameW + x) * 4;
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
        }
      }
      const n = cellW * cellH;
      const ar = roundDiv(r, n);
      const ag = roundDiv(g, n);
      const ab = roundDiv(b, n);

      for (let y = top; y < top + cellH; y += 1) {
        for (let x = left; x < left + cellW; x += 1) {
          const i = (y * frameW + x) * 4;
          data[i] = ar;
          data[i + 1] = ag;
          data[i + 2] = ab;
        }
      }
    }
  }
}

/**
 * {@link BLUR_PASSES} passes of a separable box average over the rect.
 *
 * Works on a copy of the rect's RGB, because a box average has to read
 * the *input* of its pass — blurring in place feeds each pixel's new
 * value into its neighbour's window and smears the result along the scan
 * direction.
 */
export function boxBlur(
  data: Uint8ClampedArray,
  frameW: number,
  rect: PixelRect,
  radius: number
): void {
  if (radius <= 0) return;
  let buf = extractRgb(data, frameW, rect);
  for (let pass = 0; pass < BLUR_PASSES; pass += 1) {
    buf = boxPass(buf, rect.w, rect.h, radius, "horizontal");
    buf = boxPass(buf, rect.w, rect.h, radius, "vertical");
  }
  writeRgb(data, frameW, rect, buf);
}

type Axis = "horizontal" | "vertical";

/** One separable box-average pass over a packed RGB buffer. */
function boxPass(
  src: Uint8Array,
  w: number,
  h: number,
  radius: number,
  axis: Axis
): Uint8Array {
  const out = new Uint8Array(w * h * 3);
  // Symmetric, so 2r+1 samples — never zero, which is what makes the
  // mean below safe to take.
  const window = radius * 2 + 1;
  const horizontal = axis === "horizontal";
  const span = horizontal ? w : h;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      const centre = horizontal ? x : y;
      for (let offset = 0; offset < window; offset += 1) {
        // Clamp to the rect: the edge sample repeats rather than
        // wrapping or reading outside.
        const at = Math.min(Math.max(centre + offset - radius, 0), span - 1);
        const i = horizontal ? (y * w + at) * 3 : (at * w + x) * 3;
        r += src[i]!;
        g += src[i + 1]!;
        b += src[i + 2]!;
      }
      const o = (y * w + x) * 3;
      out[o] = roundDiv(r, window);
      out[o + 1] = roundDiv(g, window);
      out[o + 2] = roundDiv(b, window);
    }
  }
  return out;
}

/** Copy a rect's RGB into a tightly packed buffer, dropping alpha. */
function extractRgb(
  data: Uint8ClampedArray,
  frameW: number,
  rect: PixelRect
): Uint8Array {
  const buf = new Uint8Array(rect.w * rect.h * 3);
  let o = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const i = (y * frameW + x) * 4;
      buf[o] = data[i]!;
      buf[o + 1] = data[i + 1]!;
      buf[o + 2] = data[i + 2]!;
      o += 3;
    }
  }
  return buf;
}

/** Write a packed RGB buffer back over a rect, leaving alpha as it was. */
function writeRgb(
  data: Uint8ClampedArray,
  frameW: number,
  rect: PixelRect,
  buf: Uint8Array
): void {
  for (let row = 0; row < rect.h; row += 1) {
    for (let col = 0; col < rect.w; col += 1) {
      const s = (row * rect.w + col) * 3;
      const d = ((rect.y + row) * frameW + (rect.x + col)) * 4;
      data[d] = buf[s]!;
      data[d + 1] = buf[s + 1]!;
      data[d + 2] = buf[s + 2]!;
    }
  }
}

/**
 * Apply every pixel-filter annotation covering `ms` to a frame's pixels.
 *
 * Mirrors `domain::annotation::apply_redactions`, including its order:
 * where two overlap, the later one wins on the shared pixels — the same
 * last-writer rule the drawn annotations get for free by being
 * composited in order.
 */
export function applyRedactions(
  data: Uint8ClampedArray,
  frameW: number,
  frameH: number,
  annotations: readonly Annotation[],
  ms: number
): void {
  for (const annotation of annotations) {
    if (!isPixelFilter(annotation) || !coversMs(annotation, ms)) continue;
    const rect = normToPixels(annotation.rect, frameW, frameH);
    if (!rect) continue;
    if (annotation.kind === "pixelate") {
      pixelate(data, frameW, rect, annotation.block);
    } else {
      boxBlur(data, frameW, rect, annotation.radius);
    }
  }
}
