/**
 * Shared helper for the Blur / Magnifier "sample" regions: locate the capture's
 * base image to re-sample. Both renderers (the live SVG `SceneNodeView` and the
 * Canvas2D export `render.ts`) call this with the same node map, so a sample
 * region looks identical live and on export. See ADR 0010.
 */

import { nodeBounds, type Rect, type SceneNode } from "../types";
import { imageFill } from "./paint";

export interface BaseImage {
  /** Id of the node carrying the image fill — the capture itself. The page
   *  model (`lib/page.ts`) pads and treats *this* node, so it needs the id
   *  rather than re-deriving "which node is the capture" from scratch. */
  id: string;
  src: string;
  /** The image's displayed rect in scene space (drawn with cover/`slice`). */
  rect: Rect;
}

/**
 * The base image to sample: the largest-area image node in the scene. Robust
 * for the common single-capture document, and a sensible heuristic if several
 * images are present (the capture is the biggest). Returns null when there's no
 * image — sample regions then render only their stroke.
 */
export function findBaseImage(
  nodes: Record<string, SceneNode>
): BaseImage | null {
  let best: BaseImage | null = null;
  let bestArea = -1;
  for (const id of Object.keys(nodes)) {
    const node = nodes[id]!;
    const fill = imageFill(node.fills);
    if (!fill?.src) continue;
    const rect = nodeBounds(node);
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      best = { id, src: fill.src, rect };
    }
  }
  return best;
}

/**
 * Draw `img` to `rect` with "cover" sizing — fill the box, overflowing whichever
 * axis is too long, centered. The single source of this math, shared by the
 * export's image fills/sample regions and the pixelate helper below so they all
 * align identically.
 */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement,
  rect: Rect
): void {
  const { x, y, width: w, height: h } = rect;
  const ar = img.width / img.height;
  let dw = w;
  let dh = h;
  if (ar > w / h) dw = h * ar;
  else dh = w / ar;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** Decode cache for the live SVG pixelate path (the Canvas2D export collects its
 *  own decoded images up front). Keyed by src; data URIs decode fast/untainted. */
const imageCache = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        imageCache.delete(src); // don't cache a permanent failure
        reject(new Error(`failed to decode ${src.slice(0, 32)}…`));
      };
      img.src = src;
    });
    imageCache.set(src, p);
  }
  return p;
}

/**
 * Render the base image into `region` (a sample node's local box) as a mosaic of
 * `cell`-px blocks: cover-draw the slice under the region, average-downsample to
 * one pixel per cell, then nearest-neighbour upsample back. Returns a
 * region-sized canvas, or null when a 2D context is unavailable (e.g. jsdom).
 *
 * The grid is anchored to the region's top-left and the algorithm is identical
 * on both sides, so the live SVG (`SceneNodeView`) and the Canvas2D export
 * (`render.ts`) — which both call this — produce the same mosaic.
 */
export function pixelateRegion(
  img: HTMLImageElement,
  baseRect: Rect,
  region: Rect,
  cell: number
): HTMLCanvasElement | null {
  const w = Math.max(1, Math.round(region.width));
  const h = Math.max(1, Math.round(region.height));
  const c = Math.max(2, Math.round(cell));
  const cols = Math.max(1, Math.round(w / c));
  const rows = Math.max(1, Math.round(h / c));

  // Cover-draw the slice under the region, offset so region's top-left → (0,0).
  const full = document.createElement("canvas");
  full.width = w;
  full.height = h;
  const fctx = full.getContext("2d");
  if (!fctx) return null;
  fctx.translate(-region.x, -region.y);
  drawCover(fctx, img, baseRect);

  // Average each cell to its mean colour…
  const small = document.createElement("canvas");
  small.width = cols;
  small.height = rows;
  const sctx = small.getContext("2d");
  if (!sctx) return null;
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(full, 0, 0, w, h, 0, 0, cols, rows);

  // …then blow it back up with hard block edges.
  const octx = full.getContext("2d");
  if (!octx) return null;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, w, h);
  octx.imageSmoothingEnabled = false;
  octx.drawImage(small, 0, 0, cols, rows, 0, 0, w, h);
  return full;
}
