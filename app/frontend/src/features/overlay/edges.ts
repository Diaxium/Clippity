/**
 * Edge detection for the Magnetic Lasso.
 *
 * The lasso snaps the cursor to the strongest nearby image edge so the
 * user can trace an object without pixel-precise mouse work. Edges come
 * from a Sobel gradient over the cached desktop snapshot's luminance —
 * the same `snapshot.sampleCtx` the magnifier samples (physical-pixel
 * canvas; logical → physical is `* devicePixelRatio`, matching
 * `Magnifier.tsx`).
 *
 * The Sobel core is split out as a pure function over a luminance buffer
 * so it unit-tests without a real `<canvas>` (jsdom has no 2D raster).
 */

import type { Pt } from "./types";

/** Sobel gradient magnitude below this (0–~1448 scale) is treated as
 *  "no edge" — the lasso keeps the raw cursor instead of snapping to
 *  flat-region noise. */
export const MIN_EDGE_MAG = 130;

/** Default search radius (logical px) around the cursor for a snap. */
export const SNAP_RADIUS = 8;

/** Rec. 601 luma of an RGBA pixel at `i` (the R index) in `data`. */
function luma(data: Uint8ClampedArray | number[], i: number): number {
  const r = data[i] ?? 0;
  const g = data[i + 1] ?? 0;
  const b = data[i + 2] ?? 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Sobel gradient magnitude at `(x, y)` in a `w × h` luminance buffer.
 *  Returns 0 on the 1px border (neighbours unavailable). Pure. */
export function sobelAt(
  lum: readonly number[] | Float32Array,
  w: number,
  h: number,
  x: number,
  y: number
): number {
  if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return 0;
  const at = (xx: number, yy: number) => lum[yy * w + xx] ?? 0;
  const gx =
    -at(x - 1, y - 1) -
    2 * at(x - 1, y) -
    at(x - 1, y + 1) +
    at(x + 1, y - 1) +
    2 * at(x + 1, y) +
    at(x + 1, y + 1);
  const gy =
    -at(x - 1, y - 1) -
    2 * at(x, y - 1) -
    at(x + 1, y - 1) +
    at(x - 1, y + 1) +
    2 * at(x, y + 1) +
    at(x + 1, y + 1);
  return Math.hypot(gx, gy);
}

/**
 * Find the strongest edge pixel within `r` of `(cx, cy)` in a `w × h`
 * luminance buffer, biased toward the centre so the snap doesn't leap to
 * a marginally-stronger edge far from the cursor. Returns the winning
 * `{ x, y, mag }`, or `null` when no candidate clears `MIN_EDGE_MAG`.
 * Pure — the canvas-free heart of `snapToEdge`.
 */
export function strongestEdge(
  lum: readonly number[] | Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  r: number
): { x: number; y: number; mag: number } | null {
  let best: { x: number; y: number; mag: number } | null = null;
  let bestScore = -Infinity;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > r) continue;
      const mag = sobelAt(lum, w, h, x, y);
      if (mag < MIN_EDGE_MAG) continue;
      // Proximity bias: discount far candidates so the snap stays near
      // the cursor (up to 50% at the search edge).
      const score = mag * (1 - 0.5 * (dist / r));
      if (score > bestScore) {
        bestScore = score;
        best = { x, y, mag };
      }
    }
  }
  return best;
}

/**
 * Snap `target` (logical px) to the nearest strong edge in the snapshot
 * `ctx`, searching within `radius` logical px. Returns the snapped point
 * (logical px) or `target` unchanged when there's no edge nearby / the
 * read fails. `dpr` maps logical → the canvas's physical pixels.
 */
export function snapToEdge(
  ctx: CanvasRenderingContext2D,
  target: Pt,
  radius = SNAP_RADIUS,
  dpr = 1
): Pt {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const cx = Math.round(target.x * dpr);
  const cy = Math.round(target.y * dpr);
  const rPhys = Math.max(1, Math.round(radius * dpr));
  // Read a (block) window with a 1px Sobel border, clamped to canvas.
  const x0 = Math.max(0, cx - rPhys - 1);
  const y0 = Math.max(0, cy - rPhys - 1);
  const x1 = Math.min(cw - 1, cx + rPhys + 1);
  const y1 = Math.min(ch - 1, cy + rPhys + 1);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  if (bw < 3 || bh < 3) return target;

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x0, y0, bw, bh).data;
  } catch {
    return target;
  }
  const lum = new Float32Array(bw * bh);
  for (let i = 0; i < bw * bh; i++) lum[i] = luma(data, i * 4);

  const best = strongestEdge(lum, bw, bh, cx - x0, cy - y0, rPhys);
  if (!best) return target;
  return { x: (best.x + x0) / dpr, y: (best.y + y0) / dpr };
}
