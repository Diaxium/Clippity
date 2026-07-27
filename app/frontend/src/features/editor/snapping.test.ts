import { describe, expect, it } from "vitest";

import {
  alignmentGuides,
  buildSnapLines,
  excludeSet,
  snapMove,
  snapPoint,
  type SnapLine,
} from "./snapping";
import {
  __resetNodeIdForTests,
  makeFrame,
  makeRectangle,
  type Rect,
  type SceneNode,
} from "./types";

function scene(): Record<string, SceneNode> {
  __resetNodeIdForTests();
  // A 100×100 box at (0,0) and a 100×100 box at (300,0).
  const a = makeRectangle(
    { x: 0, y: 0, width: 100, height: 100 },
    { name: "A" }
  );
  const b = makeRectangle(
    { x: 300, y: 0, width: 100, height: 100 },
    { name: "B" }
  );
  return { [a.id]: a, [b.id]: b };
}

describe("excludeSet", () => {
  it("includes a frame and its descendants", () => {
    __resetNodeIdForTests();
    const frame = makeFrame(
      { x: 0, y: 0, width: 200, height: 200 },
      { name: "F" }
    );
    const child = makeRectangle(
      { x: 10, y: 10, width: 20, height: 20 },
      { name: "C" }
    );
    frame.children = [child.id];
    const nodes = { [frame.id]: frame, [child.id]: child };
    const ex = excludeSet(nodes, [frame.id]);
    expect(ex.has(frame.id)).toBe(true);
    expect(ex.has(child.id)).toBe(true);
  });
});

describe("buildSnapLines", () => {
  it("emits edge + center lines per visible node and skips excluded", () => {
    const nodes = scene();
    const [aId, bId] = Object.keys(nodes);
    const lines = buildSnapLines(nodes, new Set([aId!]), null);
    // Only B contributes: 3 x-lines + 3 y-lines.
    expect(lines.filter((l) => l.axis === "x")).toHaveLength(3);
    expect(lines.filter((l) => l.axis === "y")).toHaveLength(3);
    const xs = lines
      .filter((l) => l.axis === "x")
      .map((l) => l.pos)
      .sort((m, n) => m - n);
    expect(xs).toEqual([300, 350, 400]);
    expect(bId).toBeTruthy();
  });

  it("skips hidden and locked nodes", () => {
    const nodes = scene();
    const ids = Object.keys(nodes);
    nodes[ids[1]!]!.visible = false;
    const lines = buildSnapLines(nodes, new Set([ids[0]!]), null);
    expect(lines).toHaveLength(0);
  });

  it("adds an artboard center cross when bounds are given", () => {
    const nodes = scene();
    const bounds: Rect = { x: 0, y: 0, width: 400, height: 200 };
    const lines = buildSnapLines(nodes, new Set(Object.keys(nodes)), bounds);
    const canvas = lines.filter((l) => l.kind === "canvas");
    expect(canvas).toHaveLength(2);
    expect(canvas.find((l) => l.axis === "x")!.pos).toBe(200);
    expect(canvas.find((l) => l.axis === "y")!.pos).toBe(100);
  });
});

describe("snapMove", () => {
  const lines: SnapLine[] = [
    { axis: "x", pos: 300, lo: 0, hi: 100, kind: "edge" },
    { axis: "y", pos: 0, lo: 300, hi: 400, kind: "edge" },
  ];

  it("nudges a near-aligned rect onto the line and reports a guide", () => {
    // Moving box left edge at 296 → should snap +4 to x=300.
    const proposed: Rect = { x: 296, y: 0, width: 100, height: 100 };
    const res = snapMove(proposed, lines, 1);
    expect(res.dx).toBe(4);
    expect(res.dy).toBe(0);
    expect(res.guides.some((g) => g.axis === "x" && g.pos === 300)).toBe(true);
  });

  it("does not snap when outside the threshold", () => {
    const proposed: Rect = { x: 280, y: 50, width: 100, height: 100 };
    const res = snapMove(proposed, lines, 1);
    expect(res.dx).toBe(0);
    expect(res.guides).toHaveLength(0);
  });

  it("scales the snap radius by zoom (screen-constant)", () => {
    // 8px off in scene units; at zoom 2 that's 16 screen px (> 6) → no snap.
    const proposed: Rect = { x: 308, y: 0, width: 100, height: 100 };
    expect(snapMove(proposed, lines, 2).dx).toBe(0);
    // At zoom 0.5, 8 scene px = 4 screen px (< 6) → snaps.
    expect(snapMove(proposed, lines, 0.5).dx).toBe(-8);
  });
});

describe("alignmentGuides", () => {
  it("merges coincident lines and keeps the strongest kind + widest extent", () => {
    const lines: SnapLine[] = [
      { axis: "x", pos: 100, lo: 0, hi: 50, kind: "edge" },
      { axis: "x", pos: 100, lo: 200, hi: 260, kind: "canvas" },
    ];
    const rect: Rect = { x: 100, y: 80, width: 40, height: 40 };
    const guides = alignmentGuides(rect, lines, 6);
    expect(guides).toHaveLength(1);
    expect(guides[0]!.kind).toBe("canvas");
    expect(guides[0]!.start).toBe(0);
    expect(guides[0]!.end).toBe(260);
  });
});

describe("snapPoint", () => {
  const lines: SnapLine[] = [
    { axis: "x", pos: 300, lo: 0, hi: 100, kind: "edge" },
    { axis: "y", pos: 200, lo: 0, hi: 100, kind: "edge" },
  ];

  it("snaps each axis independently within threshold", () => {
    expect(snapPoint({ x: 303, y: 197 }, lines, 1)).toEqual({ x: 300, y: 200 });
  });

  it("leaves an axis untouched when no line is near", () => {
    expect(snapPoint({ x: 303, y: 50 }, lines, 1)).toEqual({ x: 300, y: 50 });
  });
});
