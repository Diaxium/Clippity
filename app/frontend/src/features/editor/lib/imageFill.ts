/**
 * Image-fill sizing + anchor math, shared by both renderers (Workstream FE5) so
 * an image fill looks identical in the live SVG (`preserveAspectRatio`) and the
 * Canvas2D export (`drawImage`). Default fill/center reproduces the old "cover".
 */

import type { ImageAlign, ImageScale, Rect } from "../types";

/** Anchor fractions (0 | 0.5 | 1) per axis for an image-fill alignment. */
export function imageAlignFractions(align: ImageAlign): {
  ax: number;
  ay: number;
} {
  const ax = align.includes("left") ? 0 : align.includes("right") ? 1 : 0.5;
  const ay = align.includes("top") ? 0 : align.includes("bottom") ? 1 : 0.5;
  return { ax, ay };
}

/** SVG `preserveAspectRatio` align token (e.g. "xMidYMid") for an alignment. */
export function imageAlignToken(align: ImageAlign): string {
  const { ax, ay } = imageAlignFractions(align);
  const x = ax === 0 ? "xMin" : ax === 1 ? "xMax" : "xMid";
  const y = ay === 0 ? "YMin" : ay === 1 ? "YMax" : "YMid";
  return x + y;
}

/** Full SVG `preserveAspectRatio` for an image fill's scale + align. */
export function imagePreserveAspectRatio(
  scale: ImageScale,
  align: ImageAlign
): string {
  if (scale === "stretch") return "none";
  return `${imageAlignToken(align)} ${scale === "fit" ? "meet" : "slice"}`;
}

/** Draw `img` into `rect` honoring scale (fill/fit/stretch) + align — the
 *  Canvas2D counterpart of {@link imagePreserveAspectRatio}. */
export function drawImageFill(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement,
  rect: Rect,
  scale: ImageScale,
  align: ImageAlign
): void {
  const { x, y, width: w, height: h } = rect;
  if (scale === "stretch") {
    ctx.drawImage(img, x, y, w, h);
    return;
  }
  const ar = img.width / img.height;
  let dw: number;
  let dh: number;
  if (scale === "fill") {
    // Cover: fill the box, overflowing the longer axis.
    if (ar > w / h) {
      dh = h;
      dw = h * ar;
    } else {
      dw = w;
      dh = w / ar;
    }
  } else {
    // Fit (contain): sit fully inside the box, letterboxing the shorter axis.
    if (ar > w / h) {
      dw = w;
      dh = w / ar;
    } else {
      dh = h;
      dw = h * ar;
    }
  }
  const { ax, ay } = imageAlignFractions(align);
  ctx.drawImage(img, x + (w - dw) * ax, y + (h - dh) * ay, dw, dh);
}
