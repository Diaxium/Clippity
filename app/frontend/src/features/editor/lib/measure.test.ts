import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeLine,
  makeRectangle,
  makeStroke,
  type LineNode,
  type MeasureSpec,
} from "../types";
import {
  canCarryMeasure,
  clampMeasureScale,
  formatMeasure,
  labelCorners,
  measureBounds,
  measureGeometry,
  measureLength,
  measureOf,
  measureValue,
} from "./measure";

const SPEC: MeasureSpec = { caps: "tick", scale: 1, unit: "px" };

/** A dimension line from (x,y) running (dx,dy) — line-like nodes encode their
 *  direction in signed width/height. */
function dimension(
  dx: number,
  dy: number,
  spec: Partial<MeasureSpec> = {},
  strokeWidth = 2
): LineNode {
  __resetNodeIdForTests();
  const n = makeLine(
    { x: 100, y: 200, width: dx, height: dy },
    { strokes: [makeStroke("#f24822", strokeWidth)] }
  );
  n.measure = { ...SPEC, ...spec };
  return n;
}

describe("measure model guards", () => {
  it("only line-like nodes can carry a measurement", () => {
    // A dimension's defining property is having two endpoints, which is what
    // line-like nodes model and box nodes don't.
    expect(canCarryMeasure(dimension(100, 0))).toBe(true);
    __resetNodeIdForTests();
    const box = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    expect(canCarryMeasure(box)).toBe(false);
  });

  it("treats a spec stranded on a box shape as inert", () => {
    __resetNodeIdForTests();
    const box = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    box.measure = SPEC;
    expect(measureOf(box)).toBeNull();
    expect(measureGeometry(box)).toBeNull();
  });

  it("draws nothing for a line too short to have a direction", () => {
    // Below the floor there is no unit vector to lay the dimension out along,
    // so the mark renders as nothing rather than as NaN.
    expect(measureGeometry(dimension(0, 0))).toBeNull();
    expect(measureBounds(dimension(0, 0))).toBeNull();
  });
});

describe("the measured number", () => {
  it("is the line's own length, so it can never disagree with the geometry", () => {
    expect(measureLength(dimension(300, 400))).toBe(500);
  });

  it("re-expresses that length through the spec's scale", () => {
    // A 2× (HiDPI) capture measured in logical px.
    expect(
      measureValue(dimension(300, 400, { scale: 0.5 }), {
        ...SPEC,
        scale: 0.5,
      })
    ).toBe(250);
  });

  it("rejects a scale that would report a nonsense length", () => {
    expect(clampMeasureScale(0)).toBe(1);
    expect(clampMeasureScale(-4)).toBe(1);
    expect(clampMeasureScale(Number.NaN)).toBe(1);
    expect(clampMeasureScale(1e9)).toBe(1000);
  });

  it("rounds to a tenth and drops a trailing .0", () => {
    // A dimension read off a screenshot is never more precise than that, and a
    // full float would make the label pill jitter in width through a drag.
    expect(formatMeasure(248, "px")).toBe("248 px");
    expect(formatMeasure(248.04, "px")).toBe("248 px");
    expect(formatMeasure(248.46, "px")).toBe("248.5 px");
    expect(formatMeasure(248, "")).toBe("248");
  });
});

describe("measureGeometry", () => {
  it("breaks the shaft into two segments around the label", () => {
    const geo = measureGeometry(dimension(600, 0))!;
    expect(geo.shaft).toHaveLength(2);
    // Both segments run along the line, and the gap sits at the midpoint.
    const [first, second] = geo.shaft;
    expect(first![0]).toEqual({ x: 100, y: 200 });
    expect(second![1]).toEqual({ x: 700, y: 200 });
    expect(first![1]!.x).toBeLessThan(400);
    expect(second![0]!.x).toBeGreaterThan(400);
    expect(geo.label.cx).toBe(400);
    expect(geo.label.cy).toBe(200);
  });

  it("drops the shaft entirely when the label spans the whole line", () => {
    // A short dimension is label + caps; there is nowhere left to draw a rule.
    const geo = measureGeometry(dimension(24, 0))!;
    expect(geo.shaft).toHaveLength(0);
    expect(geo.ticks).toHaveLength(2);
  });

  it("puts perpendicular serifs at both endpoints for tick caps", () => {
    const geo = measureGeometry(dimension(600, 0))!;
    expect(geo.heads).toHaveLength(0);
    expect(geo.ticks).toHaveLength(2);
    // Horizontal line ⇒ the serifs are vertical, centred on each endpoint.
    const [a, b] = geo.ticks[0]!;
    expect(a.x).toBeCloseTo(100);
    expect(b.x).toBeCloseTo(100);
    expect(a.y).toBeLessThan(200);
    expect(b.y).toBeGreaterThan(200);
  });

  it("swaps the serifs for outward arrowheads and insets the shaft", () => {
    const tick = measureGeometry(dimension(600, 0))!;
    const arrow = measureGeometry(dimension(600, 0, { caps: "arrow" }))!;
    expect(arrow.ticks).toHaveLength(0);
    expect(arrow.heads).toHaveLength(2);
    // Each head's tip is the endpoint it marks, and it opens back inward.
    expect(arrow.heads[0]![0]).toEqual({ x: 100, y: 200 });
    expect(arrow.heads[1]![0]).toEqual({ x: 700, y: 200 });
    expect(arrow.heads[0]![1]!.x).toBeGreaterThan(100);
    // The shaft stops short of the barbs so they stay sharp — the same inset a
    // plain arrow node already applies.
    expect(arrow.shaft[0]![0]!.x).toBeGreaterThan(tick.shaft[0]![0]!.x);
  });

  it("keeps the label within a quarter turn of upright", () => {
    // Past ±90° the same line read from the other end is the same dimension, so
    // the label flips rather than rendering the number upside down.
    expect(measureGeometry(dimension(600, 0))!.label.rotation).toBeCloseTo(0);
    expect(measureGeometry(dimension(-600, 0))!.label.rotation).toBeCloseTo(0);
    expect(measureGeometry(dimension(0, 600))!.label.rotation).toBeCloseTo(90);
    expect(measureGeometry(dimension(0, -600))!.label.rotation).toBeCloseTo(90);
    const back = measureGeometry(dimension(-600, -100))!.label.rotation;
    expect(back).toBeGreaterThan(-90);
    expect(back).toBeLessThanOrEqual(90);
  });

  it("takes color, width and opacity from the node's top stroke", () => {
    const n = dimension(600, 0);
    n.strokes = [makeStroke("#0d99ff", 4)];
    n.strokes[0]!.opacity = 0.5;
    const geo = measureGeometry(n)!;
    expect(geo.color).toBe("#0d99ff");
    expect(geo.width).toBe(4);
    expect(geo.opacity).toBe(0.5);
    // The pill wears the stroke color with contrast-picked ink, so the label
    // belongs to the line it labels.
    expect(geo.label.plate).toBe("#0d99ff");
    expect(geo.label.color).toBe("#eceef0");
  });

  it("stays visible when every stroke was deleted", () => {
    // Otherwise the mark would vanish with no way to get it back.
    const n = dimension(600, 0);
    n.strokes = [];
    const geo = measureGeometry(n);
    expect(geo).not.toBeNull();
    expect(geo!.width).toBeGreaterThan(0);
  });

  it("picks dark ink for a light stroke color", () => {
    const n = dimension(600, 0);
    n.strokes = [makeStroke("#ffe24d", 2)];
    expect(measureGeometry(n)!.label.color).toBe("#1c1d20");
  });

  it("never rounds the label pill wider than the pill itself", () => {
    // Canvas2D's `arcTo` draws a distorted corner where SVG's `rx` clamps.
    const geo = measureGeometry(dimension(600, 0))!;
    expect(geo.label.radius).toBeLessThanOrEqual(geo.label.width / 2);
    expect(geo.label.radius).toBeLessThanOrEqual(geo.label.height / 2);
  });
});

describe("measureBounds", () => {
  it("covers the decorations a horizontal line's own frame has no room for", () => {
    // The node's frame is a zero-height segment; the serifs and the label pill
    // all hang off it, so a one-node export sized from the frame would be a
    // 1px-tall strip (the ADR 0022 trap, from a second direction).
    const n = dimension(600, 0);
    const b = measureBounds(n)!;
    expect(b.height).toBeGreaterThan(20);
    const label = measureGeometry(n)!.label;
    for (const corner of labelCorners(label)) {
      expect(corner.x).toBeGreaterThanOrEqual(b.x);
      expect(corner.x).toBeLessThanOrEqual(b.x + b.width);
      expect(corner.y).toBeGreaterThanOrEqual(b.y);
      expect(corner.y).toBeLessThanOrEqual(b.y + b.height);
    }
  });

  it("still contains both endpoints", () => {
    const b = measureBounds(dimension(300, 400))!;
    expect(b.x).toBeLessThanOrEqual(100);
    expect(b.y).toBeLessThanOrEqual(200);
    expect(b.x + b.width).toBeGreaterThanOrEqual(400);
    expect(b.y + b.height).toBeGreaterThanOrEqual(600);
  });
});
