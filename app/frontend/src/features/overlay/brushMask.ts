/**
 * The Brush selection's painted alpha mask.
 *
 * The actual painted pixels live in a lazily-created offscreen canvas
 * sized to the overlay viewport in DEVICE pixels — which, because the
 * overlay window spans the virtual desktop 1:1, are exactly the
 * canvas-local physical pixels the backend crops in. The Zustand store
 * holds only lightweight metadata (size / mode / a version counter);
 * keeping the mutable raster here avoids putting an imperatively-mutated
 * canvas in React state.
 *
 * `useBrushSelection` paints into it, `BrushMask` blits it (tinted), and
 * `useOverlayFinalize` reads it back as a run-length-encoded
 * `BrushMask` wire payload. `reset()` / `clearSelection()` clear it.
 */

import type { BrushMask, Pt } from "./types";

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;

/** Lazily create / re-fit the offscreen mask canvas to the current
 *  viewport in device pixels. Returns `null` when there's no DOM canvas
 *  (e.g. the node test environment). */
function ensureCtx(): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (!canvas) {
    canvas = document.createElement("canvas");
  }
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  } else if (!ctx) {
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  return ctx;
}

/** The offscreen canvas for the visible `BrushMask` layer to blit, or
 *  `null` before the first paint. */
export function maskCanvas(): HTMLCanvasElement | null {
  return canvas;
}

/**
 * Paint a round-capped stroke segment `from → to` (logical px) into the
 * mask at `diameter` logical px. `subtract` erases instead of adds.
 * A zero-length segment paints a single dot.
 */
export function paintSegment(
  from: Pt,
  to: Pt,
  diameter: number,
  subtract: boolean
): void {
  const c = ensureCtx();
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const r = (diameter * dpr) / 2;
  c.save();
  c.globalCompositeOperation = subtract ? "destination-out" : "source-over";
  c.fillStyle = "rgba(255,255,255,1)";
  c.strokeStyle = "rgba(255,255,255,1)";
  c.lineWidth = r * 2;
  c.lineCap = "round";
  c.lineJoin = "round";
  const fx = from.x * dpr;
  const fy = from.y * dpr;
  const tx = to.x * dpr;
  const ty = to.y * dpr;
  if (fx === tx && fy === ty) {
    c.beginPath();
    c.arc(fx, fy, r, 0, Math.PI * 2);
    c.fill();
  } else {
    c.beginPath();
    c.moveTo(fx, fy);
    c.lineTo(tx, ty);
    c.stroke();
  }
  c.restore();
}

/** Erase the whole mask. */
export function clearMask(): void {
  if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Device-pixel bounding box of the painted (alpha > 0) region, or
 *  `null` when nothing is painted. */
export function maskBounds(): Bounds | null {
  if (!canvas || !ctx) return null;
  const { width: W, height: H } = canvas;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, W, H).data;
  } catch {
    return null;
  }
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** True when any pixel is painted. */
export function hasInk(): boolean {
  return maskBounds() !== null;
}

/**
 * Read the painted mask back as a run-length-encoded `BrushMask` wire
 * payload in device (= canvas-local physical) pixels, or `null` when
 * nothing is painted. Runs are row-major `[alpha, count]` within the
 * painted bounding box.
 */
export function readMaskRLE(): BrushMask | null {
  if (!canvas || !ctx) return null;
  const bounds = maskBounds();
  if (!bounds) return null;
  const { width: W } = canvas;
  const { x, y, w, h } = bounds;
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x, y, w, h).data;
  } catch {
    return null;
  }
  const rle: [number, number][] = [];
  let runVal = -1;
  let runLen = 0;
  const flush = () => {
    if (runLen > 0) rle.push([runVal, runLen]);
  };
  // getImageData(x, y, w, h) is already cropped to the bbox, so iterate
  // its w*h pixels row-major directly.
  void W;
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3]!;
    if (a === runVal) {
      runLen++;
    } else {
      flush();
      runVal = a;
      runLen = 1;
    }
  }
  flush();
  return { x, y, width: w, height: h, rle };
}
