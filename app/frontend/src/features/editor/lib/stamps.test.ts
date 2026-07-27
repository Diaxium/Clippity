import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeEllipse,
  makeRectangle,
  type RectangleNode,
  type StampKind,
} from "../types";
import { nodeBounds } from "../types";
import {
  STAMPS,
  canCarryStamp,
  stampBox,
  stampGeometry,
  stampHaloWeight,
  stampLabel,
  stampOf,
  stampOutlineWeight,
  stampPreview,
} from "./stamps";

/** A stamp node with the given frame, carrying `kind`. */
function stamp(
  kind: StampKind,
  rect = { x: 100, y: 40, width: 48, height: 48 }
): RectangleNode {
  __resetNodeIdForTests();
  const n = makeRectangle(rect);
  n.stamp = { kind };
  return n;
}

/**
 * Every coordinate pair in a `d` string, control points included.
 *
 * A conservative superset of the curve's own extent (a cubic never leaves its
 * control hull), which is exactly what the "a stamp never paints outside its
 * frame" assertion below wants — it can only over-report, never miss ink.
 */
function points(d: string): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const token of d.split(" ")) {
    const body = token.replace(/^[MLCZ]/, "");
    if (!body) continue;
    const [x, y] = body.split(",").map(Number);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x: x!, y: y! });
  }
  return out;
}

const ALL: readonly StampKind[] = STAMPS.map((s) => s.kind);

describe("stamp model guards", () => {
  it("only rectangles can carry a stamp", () => {
    // A stamp's defining geometry is a box the glyph is fit into, which is what
    // the rectangle models and what the tool draws.
    expect(canCarryStamp(stamp("check"))).toBe(true);
    __resetNodeIdForTests();
    expect(
      canCarryStamp(makeEllipse({ x: 0, y: 0, width: 10, height: 10 }))
    ).toBe(false);
  });

  it("treats a spec stranded on another shape as inert", () => {
    __resetNodeIdForTests();
    const el = makeEllipse({ x: 0, y: 0, width: 40, height: 40 });
    el.stamp = { kind: "check" };
    expect(stampOf(el)).toBeNull();
    expect(stampGeometry(el)).toBeNull();
  });

  it("draws nothing for a box too small to hold a glyph", () => {
    expect(
      stampGeometry(stamp("check", { x: 0, y: 0, width: 0.4, height: 40 }))
    ).toBeNull();
  });

  it("falls back to the first icon for a kind outside the catalog", () => {
    // A scene written by a future version (or hand-edited) must still draw
    // something rather than leave an invisible node behind.
    const n = stamp("who-knows" as StampKind);
    const geo = stampGeometry(n)!;
    expect(geo).not.toBeNull();
    expect(geo.strokeD).toBe(stampGeometry(stamp(ALL[0]!))!.strokeD);
  });
});

describe("stamp catalog", () => {
  it("offers twelve icons, each with a label and some ink", () => {
    expect(ALL).toHaveLength(12);
    for (const kind of ALL) {
      expect(stampLabel(kind).length).toBeGreaterThan(0);
      const geo = stampGeometry(stamp(kind))!;
      // Every icon paints *something* — an area, a line, or both.
      expect(geo.fillD.length + geo.strokeD.length).toBeGreaterThan(0);
    }
  });

  it("emits only well-formed, finite path commands", () => {
    for (const kind of ALL) {
      const geo = stampGeometry(stamp(kind))!;
      for (const d of [geo.fillD, geo.strokeD]) {
        if (!d) continue;
        expect(d.startsWith("M")).toBe(true);
        expect(d).not.toMatch(/NaN|Infinity|undefined/);
        // Cubics only — an `A` carries flags that are ambiguous at exactly
        // 180°, which is the whole reason the module has no arc commands.
        expect(d).not.toMatch(/[AaQqSsTtVvHh]/);
        expect(points(d).length).toBeGreaterThan(0);
      }
    }
  });

  it("gives each icon a distinct drawing", () => {
    const seen = new Set(
      ALL.map((k) => {
        const g = stampGeometry(stamp(k))!;
        return `${g.fillD}|${g.strokeD}`;
      })
    );
    expect(seen.size).toBe(ALL.length);
  });
});

describe("stampBox", () => {
  it("is the node's frame when it is already square", () => {
    expect(
      stampBox(stamp("check", { x: 10, y: 20, width: 40, height: 40 }))
    ).toEqual({ x: 10, y: 20, width: 40, height: 40 });
  });

  it("is the largest centered square of a non-square frame", () => {
    // Fitting rather than stretching is what keeps the scale uniform, so the
    // icon's line weight scales with it instead of turning elliptical.
    expect(
      stampBox(stamp("check", { x: 0, y: 0, width: 100, height: 40 }))
    ).toEqual({ x: 30, y: 0, width: 40, height: 40 });
    expect(
      stampBox(stamp("check", { x: 0, y: 0, width: 40, height: 100 }))
    ).toEqual({ x: 0, y: 30, width: 40, height: 40 });
  });
});

describe("stampGeometry", () => {
  it("scales the drawing and its ink weight with the box", () => {
    const small = stampGeometry(
      stamp("info", { x: 0, y: 0, width: 24, height: 24 })
    )!;
    const large = stampGeometry(
      stamp("info", { x: 0, y: 0, width: 48, height: 48 })
    )!;
    expect(large.weight).toBeCloseTo(small.weight * 2, 6);
    const [s] = points(small.fillD);
    const [l] = points(large.fillD);
    expect(l!.x).toBeCloseTo(s!.x * 2, 3);
    expect(l!.y).toBeCloseTo(s!.y * 2, 3);
  });

  it("translates with the node", () => {
    const at0 = stampGeometry(
      stamp("star", { x: 0, y: 0, width: 40, height: 40 })
    )!;
    const at100 = stampGeometry(
      stamp("star", { x: 100, y: 60, width: 40, height: 40 })
    )!;
    const a = points(at0.fillD)[0]!;
    const b = points(at100.fillD)[0]!;
    expect(b.x - a.x).toBeCloseTo(100, 3);
    expect(b.y - a.y).toBeCloseTo(60, 3);
  });

  it("keeps every icon's ink inside the node's own frame", () => {
    // This is why stamps needed no `exportBounds` growth, unlike window chrome
    // (a bar above the node) and a dimension line (caps and label off a
    // zero-height segment): the glyph is fit *into* the frame, so the node's
    // box already is its extent — including half of the ink's line weight,
    // which straddles the path.
    for (const kind of ALL) {
      const node = stamp(kind, { x: 100, y: 40, width: 48, height: 48 });
      const b = nodeBounds(node);
      const geo = stampGeometry(node)!;
      const pad = geo.weight / 2;
      for (const p of [...points(geo.fillD), ...points(geo.strokeD)]) {
        expect(p.x).toBeGreaterThanOrEqual(b.x + pad - 0.001);
        expect(p.x).toBeLessThanOrEqual(b.x + b.width - pad + 0.001);
        expect(p.y).toBeGreaterThanOrEqual(b.y + pad - 0.001);
        expect(p.y).toBeLessThanOrEqual(b.y + b.height - pad + 0.001);
      }
    }
  });
});

describe("halo weights", () => {
  it("widens the ink line by the halo on each side", () => {
    const geo = stampGeometry(stamp("check"))!;
    expect(stampHaloWeight(geo, 3)).toBeCloseTo(geo.weight + 6, 6);
  });

  it("outlines a filled sub-path with twice the halo, half of it swallowed", () => {
    // A centered stroke straddles the edge, and the ink fill is painted over
    // the inner half — so `width * 2` leaves exactly `width` showing outside.
    expect(stampOutlineWeight(3)).toBe(6);
  });
});

describe("stampPreview", () => {
  it("is the same drawing the canvas paints, at the origin", () => {
    // The picker must show the mark you get; sharing the emitter is what makes
    // adding an icon a one-place change.
    for (const kind of ALL) {
      const preview = stampPreview(kind, 40);
      const geo = stampGeometry(
        stamp(kind, { x: 0, y: 0, width: 40, height: 40 })
      )!;
      expect(preview.fillD).toBe(geo.fillD);
      expect(preview.strokeD).toBe(geo.strokeD);
      expect(preview.weight).toBeCloseTo(geo.weight, 6);
    }
  });
});
