import { describe, expect, it } from "vitest";

import {
  angleFromCenter,
  calloutOutline,
  calloutSvgD,
  calloutTailFromLocal,
  calloutTailGeometry,
  clampZoom,
  drawRect,
  handlePoint,
  hitTestNode,
  nodeCorners,
  normalizeAngle,
  rectCenter,
  resizeFrame,
  rotatePoint,
  rotatedAABB,
  sceneToFrameLocal,
  unionBounds,
} from "./geometry";
import { makeEllipse, makeLine, makeRectangle, type Rect } from "./types";

const RECT: Rect = { x: 10, y: 20, width: 100, height: 60 };

function approx(a: number, b: number, eps = 1e-6): void {
  expect(Math.abs(a - b)).toBeLessThan(eps);
}

describe("rotatePoint", () => {
  it("is identity at 0°", () => {
    expect(rotatePoint({ x: 5, y: 7 }, { x: 0, y: 0 }, 0)).toEqual({
      x: 5,
      y: 7,
    });
  });

  it("rotates 90° clockwise about the origin", () => {
    const r = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90);
    approx(r.x, 0);
    approx(r.y, 1);
  });

  it("rotates about an arbitrary center", () => {
    const r = rotatePoint({ x: 2, y: 1 }, { x: 1, y: 1 }, 180);
    approx(r.x, 0);
    approx(r.y, 1);
  });
});

describe("rectCenter", () => {
  it("returns the geometric center", () => {
    expect(rectCenter(RECT)).toEqual({ x: 60, y: 50 });
  });
});

describe("drawRect", () => {
  const start = { x: 100, y: 100 };

  it("normalizes a box draft when unconstrained", () => {
    expect(drawRect(start, { x: 60, y: 130 }, false, false)).toEqual({
      x: 60,
      y: 100,
      width: 40,
      height: 30,
    });
  });

  it("locks a box draft to a square toward the pointer (SE)", () => {
    expect(drawRect(start, { x: 180, y: 130 }, false, true)).toEqual({
      x: 100,
      y: 100,
      width: 80,
      height: 80,
    });
  });

  it("squares toward a pointer up-and-left (NW), anchoring the far corner", () => {
    // dx=-40, dy=-90 → side 90, box grows up and left from the anchor.
    expect(drawRect(start, { x: 60, y: 10 }, false, true)).toEqual({
      x: 10,
      y: 10,
      width: 90,
      height: 90,
    });
  });

  it("keeps signed width/height for line-like drafts", () => {
    expect(drawRect(start, { x: 60, y: 130 }, true, false)).toEqual({
      x: 100,
      y: 100,
      width: -40,
      height: 30,
    });
  });

  it("snaps a line-like draft to the nearest 45° when constrained", () => {
    // Pointer slightly off horizontal snaps flat: angle → 0°, length preserved.
    const r = drawRect(start, { x: 200, y: 110 }, true, true);
    approx(r.width, Math.hypot(100, 10));
    approx(r.height, 0);
  });

  it("snaps a line-like draft to a 45° diagonal", () => {
    const r = drawRect(start, { x: 150, y: 140 }, true, true);
    approx(r.width, r.height); // equal components → 45°
  });
});

describe("sceneToFrameLocal", () => {
  it("maps the top-left corner to local origin (unrotated)", () => {
    const node = makeRectangle(RECT);
    const local = sceneToFrameLocal({ x: 10, y: 20 }, node);
    approx(local.x, 0);
    approx(local.y, 0);
  });

  it("removes rotation so the frame stays axis-aligned in local space", () => {
    const node = makeRectangle(RECT, { rotation: 90 });
    // The TL corner in scene space after a 90° rotation about the center.
    const center = rectCenter(RECT);
    const sceneTL = rotatePoint({ x: 10, y: 20 }, center, 90);
    const local = sceneToFrameLocal(sceneTL, node);
    approx(local.x, 0);
    approx(local.y, 0);
  });
});

describe("hitTestNode", () => {
  it("detects a point inside an axis-aligned rect", () => {
    const node = makeRectangle(RECT);
    expect(hitTestNode(node, { x: 50, y: 50 })).toBe(true);
    expect(hitTestNode(node, { x: 0, y: 0 })).toBe(false);
  });

  it("respects rotation", () => {
    const node = makeRectangle(
      { x: 0, y: 0, width: 100, height: 20 },
      {
        rotation: 90,
      }
    );
    // After a 90° rotation the thin bar becomes vertical through the center.
    expect(hitTestNode(node, { x: 50, y: 50 })).toBe(true);
    expect(hitTestNode(node, { x: 95, y: 10 })).toBe(false);
  });

  it("uses the ellipse equation, not the bounding box", () => {
    const node = makeEllipse({ x: 0, y: 0, width: 100, height: 100 });
    expect(hitTestNode(node, { x: 50, y: 50 })).toBe(true);
    // Corner of the bbox is outside the inscribed circle.
    expect(hitTestNode(node, { x: 4, y: 4 })).toBe(false);
  });

  it("hits a line within stroke tolerance", () => {
    const node = makeLine({ x: 0, y: 0, width: 100, height: 0 });
    expect(hitTestNode(node, { x: 50, y: 1 })).toBe(true);
    expect(hitTestNode(node, { x: 50, y: 40 })).toBe(false);
  });
});

describe("handlePoint", () => {
  it("places the eight handles on the unrotated frame", () => {
    const node = makeRectangle(RECT);
    expect(handlePoint(node, "nw")).toEqual({ x: 10, y: 20 });
    expect(handlePoint(node, "se")).toEqual({ x: 110, y: 80 });
    expect(handlePoint(node, "n")).toEqual({ x: 60, y: 20 });
    expect(handlePoint(node, "e")).toEqual({ x: 110, y: 50 });
  });
});

describe("resizeFrame (axis-aligned)", () => {
  it("se handle grows width/height from the top-left anchor", () => {
    const r = resizeFrame(RECT, 0, "se", { x: 210, y: 180 });
    expect(r).toEqual({ x: 10, y: 20, width: 200, height: 160 });
  });

  it("nw handle moves the origin and keeps the se corner fixed", () => {
    const r = resizeFrame(RECT, 0, "nw", { x: 0, y: 0 });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    // se corner unchanged.
    approx(r.x + r.width, RECT.x + RECT.width);
    approx(r.y + r.height, RECT.y + RECT.height);
  });

  it("e handle changes only width", () => {
    const r = resizeFrame(RECT, 0, "e", { x: 160, y: 999 });
    expect(r.height).toBe(RECT.height);
    expect(r.y).toBe(RECT.y);
    expect(r.width).toBe(150);
  });

  it("clamps to MIN_SIZE instead of flipping", () => {
    const r = resizeFrame(RECT, 0, "se", { x: -100, y: -100 });
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});

describe("resizeFrame (rotated) keeps the anchor fixed", () => {
  it("se drag holds the nw corner in scene space", () => {
    const rotation = 37;
    const node = makeRectangle(RECT, { rotation });
    const anchorBefore = nodeCorners(node)[0]; // TL == anchor for "se"
    const next = resizeFrame(RECT, rotation, "se", { x: 240, y: 300 });
    const anchorAfter = nodeCorners({ ...node, ...next })[0];
    approx(anchorAfter.x, anchorBefore.x, 1e-4);
    approx(anchorAfter.y, anchorBefore.y, 1e-4);
  });

  it("nw drag holds the se corner in scene space", () => {
    const rotation = -52;
    const node = makeRectangle(RECT, { rotation });
    const anchorBefore = nodeCorners(node)[2]; // BR == anchor for "nw"
    const next = resizeFrame(RECT, rotation, "nw", { x: -40, y: -10 });
    const anchorAfter = nodeCorners({ ...node, ...next })[2];
    approx(anchorAfter.x, anchorBefore.x, 1e-4);
    approx(anchorAfter.y, anchorBefore.y, 1e-4);
  });
});

describe("resizeFrame keepAspect", () => {
  it("locks the original ratio on a corner drag", () => {
    const r = resizeFrame(
      RECT,
      0,
      "se",
      { x: 410, y: 999 },
      { keepAspect: true }
    );
    approx(r.width / r.height, RECT.width / RECT.height);
  });

  it("expands the other axis on a side handle so the ratio holds", () => {
    // `e` only drives width by default; with keepAspect the height follows.
    const r = resizeFrame(
      RECT,
      0,
      "e",
      { x: 160, y: 999 },
      { keepAspect: true }
    );
    approx(r.width, 150);
    approx(r.width / r.height, RECT.width / RECT.height);
  });
});

describe("resizeFrame fromCenter (Alt)", () => {
  it("resizes symmetrically about the frame center", () => {
    // center of RECT is (60, 50); Alt keeps it fixed while both edges move.
    const r = resizeFrame(
      RECT,
      0,
      "se",
      { x: 90, y: 70 },
      { fromCenter: true }
    );
    approx(r.width, 60);
    approx(r.height, 40);
    const c = rectCenter(r);
    approx(c.x, 60);
    approx(c.y, 50);
  });

  it("keeps the ratio AND the center with Shift+Alt", () => {
    const r = resizeFrame(
      RECT,
      0,
      "se",
      { x: 90, y: 90 },
      { keepAspect: true, fromCenter: true }
    );
    approx(r.width / r.height, RECT.width / RECT.height);
    const c = rectCenter(r);
    approx(c.x, 60);
    approx(c.y, 50);
  });

  it("clamps fromCenter to MIN_SIZE (no flip through the center)", () => {
    const r = resizeFrame(RECT, 0, "e", { x: 60, y: 50 }, { fromCenter: true });
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBe(RECT.height); // side handle leaves the other axis
  });
});

describe("angleFromCenter", () => {
  it("reports 0° straight up and 90° to the right", () => {
    approx(angleFromCenter({ x: 0, y: 0 }, { x: 0, y: -10 }), 0);
    approx(angleFromCenter({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
    approx(Math.abs(angleFromCenter({ x: 0, y: 0 }, { x: 0, y: 10 })), 180);
  });
});

describe("normalizeAngle", () => {
  it("wraps into [0,360)", () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(0)).toBe(0);
  });
});

describe("rotatedAABB / unionBounds", () => {
  it("returns the frame itself when unrotated", () => {
    expect(rotatedAABB(makeRectangle(RECT))).toEqual(RECT);
  });

  it("expands the AABB for a rotated node", () => {
    const aabb = rotatedAABB(
      makeRectangle(
        { x: 0, y: 0, width: 100, height: 100 },
        {
          rotation: 45,
        }
      )
    );
    approx(aabb.width, Math.SQRT2 * 100, 1e-3);
  });

  it("unions multiple nodes", () => {
    const a = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    const b = makeRectangle({ x: 90, y: 40, width: 10, height: 10 });
    expect(unionBounds([a, b])).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(unionBounds([])).toBeNull();
  });
});

describe("clampZoom", () => {
  it("clamps to the supported range", () => {
    expect(clampZoom(0.0001)).toBeGreaterThan(0);
    expect(clampZoom(1000)).toBeLessThanOrEqual(64);
    expect(clampZoom(1)).toBe(1);
  });
});

describe("calloutOutline", () => {
  function bubble(angle: number, length: number) {
    const n = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    n.callout = { angle, length };
    return n;
  }

  it("splices the tail tip past the body, in the aimed direction", () => {
    // 180° aims straight down: tip is below the body's bottom edge.
    const down = calloutOutline(bubble(180, 40));
    expect(down).toHaveLength(7); // 4 corners + 2 base + 1 tip
    const tip = down.find((p) => p.y > 100);
    approx(tip!.x, 50);
    approx(tip!.y, 140);

    // 0° aims straight up: tip is above the top edge.
    const up = calloutOutline(bubble(0, 30));
    const upTip = up.find((p) => p.y < 0);
    approx(upTip!.x, 50);
    approx(upTip!.y, -30);
  });

  it("falls back to the bare rectangle when there is no tail", () => {
    const plain = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    expect(calloutOutline(plain)).toHaveLength(4);
  });

  it("emits a closed SVG path", () => {
    const d = calloutSvgD(bubble(90, 20)); // points right
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("120"); // tip x = 100 + 20 past the right edge
  });
});

describe("calloutTailGeometry", () => {
  function bubble(angle: number, length: number) {
    const n = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    n.callout = { angle, length };
    return n;
  }

  it("reports base on the edge and tip past it, in the aimed direction", () => {
    const down = calloutTailGeometry(bubble(180, 40))!; // straight down
    approx(down.base.x, 50);
    approx(down.base.y, 100);
    approx(down.tip.x, 50);
    approx(down.tip.y, 140);
    expect(down.edge).toBe("bottom");

    const right = calloutTailGeometry(bubble(90, 20))!; // straight right
    approx(right.base.x, 100);
    approx(right.tip.x, 120);
    expect(right.edge).toBe("right");
  });

  it("returns null when the node has no callout", () => {
    expect(
      calloutTailGeometry(makeRectangle({ x: 0, y: 0, width: 8, height: 8 }))
    ).toBeNull();
  });

  it("agrees with the tip calloutOutline splices in", () => {
    const n = bubble(215, 44); // the default down-left aim
    const geo = calloutTailGeometry(n)!;
    const tip = calloutOutline(n).find(
      (p) => p.x < 0 || p.y < 0 || p.x > 100 || p.y > 100
    )!;
    approx(tip.x, geo.tip.x);
    approx(tip.y, geo.tip.y);
  });
});

describe("calloutTailFromLocal", () => {
  function bubble(angle: number, length: number) {
    const n = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    n.callout = { angle, length };
    return n;
  }

  it("round-trips the tip back to its angle + length", () => {
    for (const [angle, length] of [
      [180, 40],
      [90, 20],
      [0, 30],
      [215, 44],
      [45, 12],
    ] as const) {
      const n = bubble(angle, length);
      const { tip } = calloutTailGeometry(n)!;
      // The node sits at the origin, so scene tip == frame-local tip.
      const back = calloutTailFromLocal(n, tip);
      approx(back.angle, angle, 1e-4);
      approx(back.length, length, 1e-4);
    }
  });

  it("clamps length to zero when the pointer is inside the body", () => {
    const n = bubble(180, 40);
    const back = calloutTailFromLocal(n, { x: 55, y: 60 }); // near the center
    expect(back.length).toBe(0);
  });
});
