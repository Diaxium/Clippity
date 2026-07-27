import { describe, expect, it } from "vitest";

import {
  hitTestNode,
  pathScenePoints,
  pathSvgD,
  polygonOutline,
  roundedRectPath,
  starOutline,
} from "./geometry";
import {
  __resetNodeIdForTests,
  cornerRadiiOf,
  createNodeForTool,
  makeImage,
  makePath,
  makePolygon,
  makeRectangle,
  makeStar,
  nextStepNumber,
  type PolygonNode,
  type StarNode,
} from "./types";

const RECT = { x: 0, y: 0, width: 100, height: 100 };

describe("makePolygon / makeStar", () => {
  it("default to a triangle and a 5-point star", () => {
    __resetNodeIdForTests();
    expect(makePolygon(RECT).sides).toBe(3);
    const star = makeStar(RECT);
    expect(star.pointCount).toBe(5);
    expect(star.innerRatio).toBeCloseTo(0.4, 5);
  });

  it("createNodeForTool builds the right node type", () => {
    __resetNodeIdForTests();
    expect(createNodeForTool("polygon", RECT)?.type).toBe("polygon");
    expect(createNodeForTool("star", RECT)?.type).toBe("star");
  });

  it("blur and magnify create sample regions", () => {
    __resetNodeIdForTests();
    const blur = createNodeForTool("blur", RECT);
    expect(blur?.type).toBe("rectangle");
    expect(blur?.sample?.mode).toBe("blur");
    expect(blur?.fills).toHaveLength(0);

    const mag = createNodeForTool("magnify", RECT);
    expect(mag?.type).toBe("ellipse");
    expect(mag?.sample?.mode).toBe("magnify");
    expect(mag?.strokes.length).toBeGreaterThan(0); // loupe ring

    const pix = createNodeForTool("pixelate", RECT);
    expect(pix?.type).toBe("rectangle");
    expect(pix?.sample?.mode).toBe("pixelate");
    expect(pix?.fills).toHaveLength(0);
  });

  it("rectangle/ellipse default to outline-only in annotation mode", () => {
    __resetNodeIdForTests();
    // Design mode: filled.
    expect(
      createNodeForTool("rectangle", RECT, "design")?.fills.length
    ).toBeGreaterThan(0);
    // Annotation mode: no fill, a stroke (a box *around* something).
    const annoRect = createNodeForTool("rectangle", RECT, "annotate");
    expect(annoRect?.fills).toHaveLength(0);
    expect(annoRect?.strokes.length).toBeGreaterThan(0);
    const annoEllipse = createNodeForTool("ellipse", RECT, "annotate");
    expect(annoEllipse?.fills).toHaveLength(0);
    expect(annoEllipse?.strokes.length).toBeGreaterThan(0);
  });

  it("highlight creates a multiply-blended filled rectangle", () => {
    __resetNodeIdForTests();
    const h = createNodeForTool("highlight", RECT);
    expect(h?.type).toBe("rectangle");
    expect(h?.blendMode).toBe("multiply");
    expect(h?.fills.length).toBeGreaterThan(0);
    expect(h?.strokes).toHaveLength(0);
  });

  it("step creates a circular badge with a step spec", () => {
    __resetNodeIdForTests();
    // A non-square drag is squared into a circle, kept circular on resize.
    const s = createNodeForTool("step", { x: 0, y: 0, width: 80, height: 40 });
    expect(s?.type).toBe("ellipse");
    expect(s?.lockAspect).toBe(true);
    expect(s?.width).toBe(s?.height);
    expect(s?.step?.number).toBe(0); // placeholder until addNode assigns
    expect(s?.fills.length).toBeGreaterThan(0);
  });

  it("callout creates a bubble rectangle with a tail spec", () => {
    __resetNodeIdForTests();
    const c = createNodeForTool("callout", RECT);
    expect(c?.type).toBe("rectangle");
    expect(typeof c?.callout?.angle).toBe("number");
    expect(c?.callout?.length).toBeGreaterThan(0);
    expect(c?.fills.length).toBeGreaterThan(0); // light body
    expect(c?.strokes.length).toBeGreaterThan(0); // accent border
  });
});

describe("nextStepNumber", () => {
  it("is 1 for an empty scene", () => {
    expect(nextStepNumber({})).toBe(1);
  });

  it("is one past the highest existing badge, ignoring non-badges", () => {
    __resetNodeIdForTests();
    const a = createNodeForTool("step", RECT)!;
    a.step = { number: 1 };
    const b = createNodeForTool("step", RECT)!;
    b.step = { number: 3 };
    const plain = makeRectangle(RECT);
    expect(
      nextStepNumber({ [a.id]: a, [b.id]: b, [plain.id]: plain })
    ).toBe(4);
  });
});

describe("polygonOutline", () => {
  it("emits one vertex per side, first pointing straight up", () => {
    const node = makePolygon(RECT, { sides: 3 }) as PolygonNode;
    const pts = polygonOutline(node);
    expect(pts).toHaveLength(3);
    expect(pts[0]!.x).toBeCloseTo(50, 5); // top-center
    expect(pts[0]!.y).toBeCloseTo(0, 5);
  });

  it("scales vertices to the node's box (non-square → ellipse fit)", () => {
    const node = makePolygon(
      { x: 0, y: 0, width: 200, height: 100 },
      { sides: 4 }
    ) as PolygonNode;
    const pts = polygonOutline(node);
    expect(pts).toHaveLength(4);
    // Square (4-gon) in a 200×100 box → right vertex at (200,50), left at (0,50).
    const xs = pts.map((p) => p.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 5);
    expect(xs[3]).toBeCloseTo(200, 5);
  });
});

describe("starOutline", () => {
  it("emits 2× the point count, alternating outer/inner radius", () => {
    const node = makeStar(RECT, { pointCount: 5, innerRatio: 0.4 }) as StarNode;
    const pts = starOutline(node);
    expect(pts).toHaveLength(10);
    expect(pts[0]!.x).toBeCloseTo(50, 5);
    expect(pts[0]!.y).toBeCloseTo(0, 5);
    // Even indices are outer points (r = 50), odd are inner (r = 20).
    expect(Math.hypot(pts[0]!.x - 50, pts[0]!.y - 50)).toBeCloseTo(50, 4);
    expect(Math.hypot(pts[1]!.x - 50, pts[1]!.y - 50)).toBeCloseTo(20, 4);
  });
});

describe("cornerRadiiOf", () => {
  it("falls back to the uniform radius and clamps to half the short side", () => {
    const node = makeRectangle(
      { x: 0, y: 0, width: 100, height: 40 },
      { cornerRadius: 100 }
    );
    // No per-corner override → all four use cornerRadius, clamped to min(w,h)/2 = 20.
    expect(cornerRadiiOf(node)).toEqual({ tl: 20, tr: 20, br: 20, bl: 20 });
  });

  it("passes through independent corners (clamped)", () => {
    const node = makeRectangle({ x: 0, y: 0, width: 200, height: 200 });
    node.cornerRadii = { tl: 10, tr: 0, br: 40, bl: 0 };
    expect(cornerRadiiOf(node)).toEqual({ tl: 10, tr: 0, br: 40, bl: 0 });
  });
});

describe("roundedRectPath", () => {
  it("starts at the top-left tangent and arcs each non-zero corner", () => {
    const d = roundedRectPath(0, 0, 100, 100, {
      tl: 10,
      tr: 10,
      br: 10,
      bl: 10,
    });
    expect(d.startsWith("M10,0")).toBe(true);
    expect(d).toContain("A10,10");
    expect(d.endsWith("Z")).toBe(true);
  });

  it("is a plain rectangle when all radii are zero (no arcs)", () => {
    const d = roundedRectPath(0, 0, 100, 100, { tl: 0, tr: 0, br: 0, bl: 0 });
    expect(d).not.toContain("A");
    expect(d).toContain("M0,0");
  });
});

describe("makeImage", () => {
  it("stores the bitmap as an image fill", () => {
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,AAA",
      {
        name: "Photo",
      }
    );
    expect(img.fills).toHaveLength(1);
    expect(img.fills[0]!.type).toBe("image");
    expect(img.fills[0]!.src).toBe("data:image/png;base64,AAA");
  });
});

describe("makePath / pathGeometry", () => {
  it("normalizes points into the bbox and round-trips back to scene", () => {
    __resetNodeIdForTests();
    const node = makePath([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 60, y: 120 },
    ]);
    expect(node.type).toBe("path");
    expect(node).toMatchObject({ x: 10, y: 20, width: 100, height: 100 });
    expect(pathScenePoints(node)).toEqual([
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 60, y: 120 },
    ]);
    expect(node.strokes).toHaveLength(1); // visible default stroke
  });

  it("guards a 1-D stroke with a 1px box", () => {
    const node = makePath([
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ]);
    expect(node.width).toBe(100);
    expect(node.height).toBe(1);
    expect(node.points.every((p) => p.y === 0)).toBe(true);
  });
});

describe("pathSvgD", () => {
  it("emits an open polyline, closed only when node.closed", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const open = pathSvgD(makePath(pts, false));
    expect(open.startsWith("M0,0")).toBe(true);
    expect(open).toContain("L");
    expect(open.endsWith("Z")).toBe(false);
    expect(pathSvgD(makePath(pts, true)).endsWith("Z")).toBe(true);
  });
});

describe("hitTestNode (path)", () => {
  it("hits near a segment and misses far away", () => {
    const node = makePath([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(hitTestNode(node, { x: 50, y: 1 })).toBe(true);
    expect(hitTestNode(node, { x: 50, y: 60 })).toBe(false);
  });
});
