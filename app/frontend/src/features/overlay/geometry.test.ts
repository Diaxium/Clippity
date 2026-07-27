import { describe, expect, it } from "vitest";

import {
  MIN_SIZE,
  applyResize,
  clampToViewport,
  farEnough,
  flattenBezier,
  freehandBounds,
  objectIndexAtPoint,
  penBounds,
  pointInRect,
  rectFromPoints,
  snapSquare,
  windowAtPoint,
} from "./geometry";

import type { DetectedObject, OverlayWindow, PenAnchor } from "./types";

describe("rectFromPoints", () => {
  it("builds a positive-area rect from two corners", () => {
    const r = rectFromPoints({ x: 100, y: 50 }, { x: 20, y: 200 });
    expect(r).toEqual({ x: 20, y: 50, w: 80, h: 150 });
  });

  it("handles identical points (zero-area rect)", () => {
    const r = rectFromPoints({ x: 10, y: 10 }, { x: 10, y: 10 });
    expect(r).toEqual({ x: 10, y: 10, w: 0, h: 0 });
  });
});

describe("pointInRect", () => {
  const r = { x: 10, y: 10, w: 100, h: 50 };

  it("returns true for points strictly inside", () => {
    expect(pointInRect({ x: 50, y: 30 }, r)).toBe(true);
  });

  it("returns true for points on the boundary (inclusive)", () => {
    expect(pointInRect({ x: 10, y: 10 }, r)).toBe(true);
    expect(pointInRect({ x: 110, y: 60 }, r)).toBe(true);
  });

  it("returns false for points outside", () => {
    expect(pointInRect({ x: 5, y: 30 }, r)).toBe(false);
    expect(pointInRect({ x: 120, y: 30 }, r)).toBe(false);
  });
});

describe("snapSquare", () => {
  it("uses the larger of the two deltas as side length", () => {
    const p = snapSquare({ x: 0, y: 0 }, { x: 50, y: 20 });
    expect(p).toEqual({ x: 50, y: 50 });
  });

  it("preserves the sign of the deltas", () => {
    const p = snapSquare({ x: 100, y: 100 }, { x: 50, y: 80 });
    expect(p).toEqual({ x: 50, y: 50 });
  });

  it("handles a zero delta in one axis", () => {
    const p = snapSquare({ x: 0, y: 0 }, { x: 0, y: 30 });
    expect(p).toEqual({ x: 30, y: 30 });
  });
});

describe("applyResize", () => {
  const base = { x: 100, y: 100, w: 200, h: 100 };

  it("grows east when dragging the e handle", () => {
    const r = applyResize(base, "e", 50, 0, false);
    expect(r).toEqual({ x: 100, y: 100, w: 250, h: 100 });
  });

  it("shrinks and re-anchors when dragging the w handle inward", () => {
    const r = applyResize(base, "w", 30, 0, false);
    expect(r).toEqual({ x: 130, y: 100, w: 170, h: 100 });
  });

  it("locks aspect ratio when the larger axis is width", () => {
    // Original aspect = 200/100 = 2. Drag e by +100 → w=300, then
    // h must become 150 to preserve the aspect. e doesn't touch n/s,
    // so y stays anchored at start.y (handler treats e/w as
    // 'middle vertical → center the height change').
    const r = applyResize(base, "e", 100, 0, true);
    expect(r.w).toBe(300);
    expect(r.h).toBe(150);
  });

  it("normalises negative width on through-flip", () => {
    // Drag e by -300 → w becomes -100 → normalise to x+w, w=100.
    const r = applyResize(base, "e", -300, 0, false);
    expect(r.x).toBe(0);
    expect(r.w).toBe(100);
  });

  it("enforces MIN_SIZE on each side", () => {
    const r = applyResize(base, "e", -300 - 200, 0, false);
    expect(r.w).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(r.h).toBeGreaterThanOrEqual(MIN_SIZE);
  });
});

describe("clampToViewport", () => {
  it("clamps an off-screen rect to fit", () => {
    const r = clampToViewport({ x: -50, y: -20, w: 200, h: 100 }, 1920, 1080);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it("shrinks width/height if they push past the right/bottom edge", () => {
    const r = clampToViewport({ x: 1900, y: 1070, w: 100, h: 50 }, 1920, 1080);
    expect(r.x + r.w).toBeLessThanOrEqual(1920);
    expect(r.y + r.h).toBeLessThanOrEqual(1080);
  });

  it("leaves an in-bounds rect untouched (modulo MIN_SIZE)", () => {
    const r = clampToViewport({ x: 100, y: 100, w: 200, h: 100 }, 1920, 1080);
    expect(r).toEqual({ x: 100, y: 100, w: 200, h: 100 });
  });
});

describe("windowAtPoint", () => {
  const win = (
    id: number,
    x: number,
    y: number,
    width: number,
    height: number
  ): OverlayWindow => ({
    id,
    title: `w${id}`,
    app: "",
    rect: { x, y, width, height },
  });

  it("returns null over bare desktop", () => {
    expect(
      windowAtPoint([win(1, 0, 0, 100, 100)], { x: 200, y: 200 }, 1)
    ).toBeNull();
  });

  it("returns the window containing the point", () => {
    const w = win(1, 10, 10, 100, 100);
    expect(windowAtPoint([w], { x: 50, y: 50 }, 1)).toBe(w);
  });

  it("returns the topmost (first) window when rects overlap", () => {
    // The list is front-to-back Z-order, so the first containing rect
    // is the topmost — exactly what a click should grab.
    const top = win(1, 0, 0, 100, 100);
    const bottom = win(2, 0, 0, 200, 200);
    expect(windowAtPoint([top, bottom], { x: 20, y: 20 }, 1)).toBe(top);
  });

  it("scales physical rects to logical px by dpr before testing", () => {
    // A 200×200 physical window at the origin is 100×100 logical at dpr 2.
    const w = win(1, 0, 0, 200, 200);
    expect(windowAtPoint([w], { x: 90, y: 90 }, 2)).toBe(w);
    expect(windowAtPoint([w], { x: 120, y: 120 }, 2)).toBeNull();
  });

  it("is top-left-inclusive, bottom-right-exclusive", () => {
    const w = win(1, 0, 0, 100, 100);
    expect(windowAtPoint([w], { x: 0, y: 0 }, 1)).toBe(w);
    expect(windowAtPoint([w], { x: 100, y: 100 }, 1)).toBeNull();
  });
});

describe("objectIndexAtPoint", () => {
  const obj = (
    x: number,
    y: number,
    width: number,
    height: number,
    label = "o"
  ): DetectedObject => ({
    rect: { x, y, width, height },
    label,
    confidence: 0.9,
  });

  it("returns null over bare desktop", () => {
    expect(
      objectIndexAtPoint([obj(0, 0, 100, 100)], { x: 200, y: 200 }, 1)
    ).toBeNull();
  });

  it("returns the index of the containing detection", () => {
    expect(
      objectIndexAtPoint([obj(10, 10, 100, 100)], { x: 50, y: 50 }, 1)
    ).toBe(0);
  });

  it("returns the SMALLEST containing box when detections nest", () => {
    // A small icon inside a large toolbar — the user should be able to
    // grab the icon, so the smaller box wins regardless of list order.
    const toolbar = obj(0, 0, 400, 80);
    const icon = obj(20, 20, 40, 40);
    expect(objectIndexAtPoint([toolbar, icon], { x: 35, y: 35 }, 1)).toBe(1);
    // Order-independent: smallest still wins when listed first.
    expect(objectIndexAtPoint([icon, toolbar], { x: 35, y: 35 }, 1)).toBe(0);
  });

  it("scales physical rects to logical px by dpr before testing", () => {
    const o = obj(0, 0, 200, 200);
    expect(objectIndexAtPoint([o], { x: 90, y: 90 }, 2)).toBe(0);
    expect(objectIndexAtPoint([o], { x: 120, y: 120 }, 2)).toBeNull();
  });

  it("is top-left-inclusive, bottom-right-exclusive", () => {
    const o = obj(0, 0, 100, 100);
    expect(objectIndexAtPoint([o], { x: 0, y: 0 }, 1)).toBe(0);
    expect(objectIndexAtPoint([o], { x: 100, y: 100 }, 1)).toBeNull();
  });

  it("returns null for an empty detection list", () => {
    expect(objectIndexAtPoint([], { x: 5, y: 5 }, 1)).toBeNull();
  });
});

describe("farEnough", () => {
  it("is true once the distance reaches the threshold", () => {
    expect(farEnough({ x: 0, y: 0 }, { x: 3, y: 0 }, 3)).toBe(true);
    expect(farEnough({ x: 0, y: 0 }, { x: 2, y: 0 }, 3)).toBe(false);
    // Diagonal: 3-4-5 triangle clears a threshold of 5.
    expect(farEnough({ x: 0, y: 0 }, { x: 3, y: 4 }, 5)).toBe(true);
  });
});

describe("freehandBounds", () => {
  it("returns null for an empty path", () => {
    expect(freehandBounds([])).toBeNull();
  });

  it("spans the min/max of the path points", () => {
    const b = freehandBounds([
      { x: 10, y: 20 },
      { x: 40, y: 5 },
      { x: 25, y: 60 },
    ]);
    expect(b).toEqual({ x: 10, y: 5, w: 30, h: 55 });
  });

  it("handles a single point (zero-area box)", () => {
    expect(freehandBounds([{ x: 7, y: 9 }])).toEqual({
      x: 7,
      y: 9,
      w: 0,
      h: 0,
    });
  });
});

describe("flattenBezier", () => {
  const corner = (x: number, y: number): PenAnchor => ({
    p: { x, y },
    hIn: null,
    hOut: null,
  });

  it("returns a closed polygon of straight segments for corner-only anchors", () => {
    const tri = [corner(0, 0), corner(10, 0), corner(10, 10)];
    const poly = flattenBezier(tri);
    // Triangle: the three corners, no duplicate closing point.
    expect(poly).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it("samples curved segments and stays within the convex hull of handles", () => {
    const a: PenAnchor = { p: { x: 0, y: 0 }, hIn: null, hOut: { x: 0, y: 10 } };
    const b: PenAnchor = {
      p: { x: 10, y: 0 },
      hIn: { x: 10, y: 10 },
      hOut: null,
    };
    const c = corner(5, -10);
    const poly = flattenBezier([a, b, c]);
    // Many more points than anchors (the curved segment is subdivided).
    expect(poly.length).toBeGreaterThan(10);
    // The curve bows downward (+y) but never past the handle extent (y=10).
    const maxY = Math.max(...poly.map((p) => p.y));
    expect(maxY).toBeGreaterThan(0);
    expect(maxY).toBeLessThanOrEqual(10 + 1e-9);
  });

  it("dedupes consecutive identical points", () => {
    const poly = flattenBezier([corner(0, 0), corner(0, 0), corner(5, 5)]);
    // The repeated (0,0) collapses to one.
    expect(poly.filter((p) => p.x === 0 && p.y === 0)).toHaveLength(1);
  });
});

describe("penBounds", () => {
  it("bounds the anchor points (handles excluded)", () => {
    const anchors: PenAnchor[] = [
      { p: { x: 5, y: 5 }, hIn: { x: -50, y: 5 }, hOut: null },
      { p: { x: 20, y: 30 }, hIn: null, hOut: null },
    ];
    expect(penBounds(anchors)).toEqual({ x: 5, y: 5, w: 15, h: 25 });
  });

  it("returns null for an empty path", () => {
    expect(penBounds([])).toBeNull();
  });
});
