/**
 * Pure geometry helpers for the region selection.
 *
 * Per-pointer-event work. No React, no state, no IPC. The unit tests
 * exercise every branch without spinning up a DOM. Coordinates are
 * logical pixels (CSS px) throughout — DPR scaling happens at the
 * IPC seam.
 */

import type {
  DetectedObject,
  OverlayWindow,
  PenAnchor,
  Pt,
  Rect,
  ResizeDir,
} from "./types";

/** Minimum side length (logical px) for a usable Region selection.
 *  Keep in lock-step with the backend `MIN_REGION_PX` (8 — the value
 *  becomes 8 × DPR physical px at the IPC seam). */
export const MIN_SIZE = 8;

/** Minimum pointer travel (logical px) before a freehand path appends a
 *  new point — subsamples the ~120 Hz move stream so the polygon stays
 *  light. Mirrors the legacy 3 px gate. */
export const MIN_FREEHAND_DIST = 3;

/** Minimum points for a usable freehand path — fewer encloses no area.
 *  Keep in lock-step with the backend `MIN_FREEHAND_POINTS`. */
export const MIN_FREEHAND_POINTS = 3;

/** Build a positive-area rect from two arbitrary corner points. */
export function rectFromPoints(a: Pt, b: Pt): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** Test whether `p` falls inside `r` (inclusive bounds). */
export function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/**
 * Snap `cur` so the rect (`start` → `cur`) is a perfect square — the
 * "Shift while dragging" behaviour. Side length is the larger of the
 * two pointer deltas so the square always contains the cursor.
 */
export function snapSquare(start: Pt, cur: Pt): Pt {
  const dx = cur.x - start.x;
  const dy = cur.y - start.y;
  const size = Math.max(Math.abs(dx), Math.abs(dy));
  const sx = dx === 0 ? 1 : Math.sign(dx);
  const sy = dy === 0 ? 1 : Math.sign(dy);
  return { x: start.x + sx * size, y: start.y + sy * size };
}

/**
 * Apply a resize delta to `start`, optionally locking aspect ratio.
 * Anchors the corner the user is NOT dragging so the grabbed corner
 * is the one that moves under the pointer. Normalises negative
 * widths/heights (drag-through-the-other-corner flip) and enforces
 * `MIN_SIZE` on each side.
 */
export function applyResize(
  start: Rect,
  dir: ResizeDir,
  dx: number,
  dy: number,
  lockRatio: boolean
): Rect {
  let { x, y, w, h } = start;
  if (dir.includes("n")) {
    y += dy;
    h -= dy;
  }
  if (dir.includes("s")) {
    h += dy;
  }
  if (dir.includes("w")) {
    x += dx;
    w -= dx;
  }
  if (dir.includes("e")) {
    w += dx;
  }

  // Aspect-ratio lock — recompute the secondary dimension so the rect
  // keeps its original shape, then re-anchor so the corner the user
  // is NOT dragging stays fixed.
  if (lockRatio && start.w > 0 && start.h > 0) {
    const aspect = start.w / start.h;
    const wDelta = Math.abs(w - start.w);
    const hDelta = Math.abs(h - start.h);
    if (wDelta >= hDelta) {
      const newH = w / aspect;
      if (dir.includes("n")) y = start.y + start.h - newH;
      else if (dir === "e" || dir === "w") y = start.y + (start.h - newH) / 2;
      // dir contains "s" with no n/w → anchor stays at start.y
      h = newH;
    } else {
      const newW = h * aspect;
      if (dir.includes("w")) x = start.x + start.w - newW;
      else if (dir === "n" || dir === "s") x = start.x + (start.w - newW) / 2;
      w = newW;
    }
  }

  // Flip handling: if width/height go negative, normalize.
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  if (w < MIN_SIZE) w = MIN_SIZE;
  if (h < MIN_SIZE) h = MIN_SIZE;
  return { x, y, w, h };
}

/** Clamp `rect` so it fits entirely inside the viewport
 *  `{ w: vw, h: vh }`. Used by the selection move/resize handlers so
 *  the user can't drag a rect off the visible overlay. */
export function clampToViewport(rect: Rect, vw: number, vh: number): Rect {
  const x = Math.max(0, Math.min(vw - MIN_SIZE, rect.x));
  const y = Math.max(0, Math.min(vh - MIN_SIZE, rect.y));
  let w = rect.w;
  let h = rect.h;
  if (x + w > vw) w = vw - x;
  if (y + h > vh) h = vh - y;
  if (w < MIN_SIZE) w = MIN_SIZE;
  if (h < MIN_SIZE) h = MIN_SIZE;
  return { x, y, w, h };
}

/**
 * Hit-test `pt` (logical px, overlay-local) against the Window-mode
 * target list; returns the window under the cursor, or `null` over bare
 * desktop. `windows` is front-to-back Z-order, so the FIRST containing
 * rect is the topmost — exactly what a hover/click should grab.
 *
 * Window rects arrive in physical px (virtual-desktop origin); the
 * overlay works in logical px, so each rect is divided by `dpr` before
 * the test. Bounds are top-left-inclusive, bottom-right-exclusive so
 * two abutting windows never both claim a shared edge pixel.
 */
export function windowAtPoint(
  windows: readonly OverlayWindow[],
  pt: Pt,
  dpr: number
): OverlayWindow | null {
  const scale = dpr || 1;
  for (const w of windows) {
    const left = w.rect.x / scale;
    const top = w.rect.y / scale;
    const right = (w.rect.x + w.rect.width) / scale;
    const bottom = (w.rect.y + w.rect.height) / scale;
    if (pt.x >= left && pt.x < right && pt.y >= top && pt.y < bottom) {
      return w;
    }
  }
  return null;
}

/**
 * Hit-test `pt` (logical px, overlay-local) against Object-mode
 * detections; returns the INDEX of the best hit, or `null` over bare
 * desktop. Unlike `windowAtPoint` (Z-ordered list, first wins),
 * detections have no Z-order — when boxes nest or overlap, the
 * SMALLEST containing box wins so the user can always reach the most
 * specific element (an icon inside a toolbar inside a window).
 *
 * Detection rects arrive in physical px (virtual-desktop origin); the
 * overlay works in logical px, so each rect is divided by `dpr` before
 * the test. Bounds are top-left-inclusive, bottom-right-exclusive,
 * matching `windowAtPoint`.
 */
export function objectIndexAtPoint(
  objects: readonly DetectedObject[],
  pt: Pt,
  dpr: number
): number | null {
  const scale = dpr || 1;
  let best: number | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < objects.length; i++) {
    const r = objects[i]!.rect;
    const left = r.x / scale;
    const top = r.y / scale;
    const right = (r.x + r.width) / scale;
    const bottom = (r.y + r.height) / scale;
    if (pt.x >= left && pt.x < right && pt.y >= top && pt.y < bottom) {
      const area = (right - left) * (bottom - top);
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
  }
  return best;
}

/** True when `b` is at least `min` logical px from `a` — the freehand
 *  subsample gate. */
export function farEnough(a: Pt, b: Pt, min: number): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) >= min;
}

/** Minimum flattened points for a usable Pen / Magnetic-Lasso polygon.
 *  Mirrors the freehand gate (the backend masks the same way). */
export const MIN_PEN_POINTS = MIN_FREEHAND_POINTS;

/** Cubic-bézier point sampling count per curved segment. A flat
 *  fixed-step subdivision is plenty for a screen-resolution mask — the
 *  backend point-in-polygon test is the consumer, not a printer. */
const BEZIER_STEPS = 16;

/** Sample one cubic bézier `p0 → p3` (control points `c1`, `c2`) at
 *  parameter `t ∈ [0,1]`. */
function cubicAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

/**
 * Flatten a closed Pen / Bézier path (anchors in draw order) into a
 * polygon of `Pt`s suitable for the freehand mask sink. Each segment
 * `anchor[i] → anchor[i+1]` is a straight line when neither side has a
 * handle, else a cubic bézier whose control points are `anchor[i].hOut`
 * and `anchor[i+1].hIn` (each falling back to its own anchor point when
 * null). The closing segment `last → first` is always included so the
 * result is a closed ring. Returns the de-duplicated point list.
 */
export function flattenBezier(anchors: readonly PenAnchor[]): Pt[] {
  if (anchors.length < 2) return anchors.map((a) => a.p);
  const out: Pt[] = [];
  const push = (pt: Pt) => {
    const prev = out[out.length - 1];
    if (!prev || prev.x !== pt.x || prev.y !== pt.y) out.push(pt);
  };
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    const b = anchors[(i + 1) % anchors.length]!;
    const straight = a.hOut === null && b.hIn === null;
    if (straight) {
      push(a.p);
      push(b.p);
      continue;
    }
    const c1 = a.hOut ?? a.p;
    const c2 = b.hIn ?? b.p;
    for (let s = 0; s <= BEZIER_STEPS; s++) {
      push(cubicAt(a.p, c1, c2, b.p, s / BEZIER_STEPS));
    }
  }
  // Drop a trailing point identical to the first (closed ring).
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && first.x === last.x && first.y === last.y) out.pop();
  return out;
}

/** Axis-aligned bounding box of a Pen path's anchors (handles excluded —
 *  the curve never bulges past a hull built from sampled points, and the
 *  bbox is only used for the on-screen selection readout). `null` for an
 *  empty path. */
export function penBounds(anchors: readonly PenAnchor[]): Rect | null {
  return freehandBounds(anchors.map((a) => a.p));
}

/** Axis-aligned bounding box of a freehand path as a `Rect`, or `null`
 *  for an empty path. Drives the selection-box render + the
 *  Capture-ready check. */
export function freehandBounds(points: readonly Pt[]): Rect | null {
  const first = points[0];
  if (!first) return null;
  let minX = first.x;
  let minY = first.y;
  let maxX = first.x;
  let maxY = first.y;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
