import { describe, expect, it } from "vitest";

import {
  applyGradientHandle,
  gradientCss,
  gradientGeometry,
  gradientLine,
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  moveFreeformPoint,
  moveMeshPoint,
  paintPreviewCss,
  rgbToHsv,
} from "./paint";
import { makeGradientPaint, makeMesh, makeSolidPaint } from "../types";

describe("hsv conversions", () => {
  it("maps the primary corners of HSV space", () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: 120, s: 1, v: 1 })).toBe("#00ff00");
    expect(hsvToHex({ h: 240, s: 1, v: 1 })).toBe("#0000ff");
    expect(hsvToHex({ h: 0, s: 0, v: 1 })).toBe("#ffffff");
    expect(hsvToHex({ h: 0, s: 0, v: 0 })).toBe("#000000");
  });

  it("round-trips rgb→hsv→rgb", () => {
    for (const rgb of [
      { r: 58, g: 123, b: 213 },
      { r: 13, g: 153, b: 255 },
      { r: 151, g: 71, b: 255 },
    ]) {
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(back).toEqual(rgb);
    }
  });

  it("round-trips hex→hsv→hex", () => {
    expect(hsvToHex(hexToHsv("#3A7BD5"))).toBe("#3a7bd5");
  });
});

describe("gradientLine", () => {
  it("points horizontally at 0° and vertically at 90°", () => {
    const h = gradientLine(0);
    expect(h).toMatchObject({ x1: 0, x2: 1 });
    expect(h.y1).toBeCloseTo(0.5, 5);
    expect(h.y2).toBeCloseTo(0.5, 5);

    const v = gradientLine(90);
    expect(v.x1).toBeCloseTo(0.5, 5);
    expect(v.y1).toBeCloseTo(0, 5);
    expect(v.y2).toBeCloseTo(1, 5);
  });
});

describe("gradientCss / paintPreviewCss", () => {
  it("renders a linear gradient with sorted stop percentages", () => {
    const paint = makeGradientPaint("#ff0000", "#0000ff");
    const css = gradientCss(paint.gradient!);
    expect(css).toContain("linear-gradient");
    expect(css).toContain("0%");
    expect(css).toContain("100%");
  });

  it("renders radial when the kind is radial", () => {
    const paint = makeGradientPaint();
    paint.gradient!.kind = "radial";
    expect(gradientCss(paint.gradient!)).toContain("radial-gradient");
  });

  it("previews a solid paint as rgba", () => {
    expect(paintPreviewCss(makeSolidPaint("#ff0000", 1))).toBe(
      "rgba(255, 0, 0, 1)"
    );
  });
});

describe("gradientGeometry", () => {
  it("fills back-compat defaults from angle (linear) and centers the radial", () => {
    const g = makeGradientPaint().gradient!; // angle 90 (vertical), linear
    const geo = gradientGeometry(g);
    expect(geo.start.y).toBeCloseTo(0, 5);
    expect(geo.end.y).toBeCloseTo(1, 5);
    expect(geo.center).toEqual({ x: 0.5, y: 0.5 });
    expect(geo.radius).toBe(0.5);
    expect(geo.shape).toBe("ellipse");
    expect(geo.focal).toEqual({ x: 0.5, y: 0.5 }); // defaults to the center
  });

  it("passes through explicit handles", () => {
    const g = makeGradientPaint().gradient!;
    g.kind = "radial";
    g.center = { x: 0.3, y: 0.4 };
    g.radius = 0.25;
    g.focal = { x: 0.2, y: 0.2 };
    g.shape = "circle";
    g.start = { x: 0.1, y: 0.1 };
    g.end = { x: 0.9, y: 0.8 };
    const geo = gradientGeometry(g);
    expect(geo.center).toEqual({ x: 0.3, y: 0.4 });
    expect(geo.radius).toBe(0.25);
    expect(geo.focal).toEqual({ x: 0.2, y: 0.2 });
    expect(geo.shape).toBe("circle");
    expect(geo.start).toEqual({ x: 0.1, y: 0.1 });
    expect(geo.end).toEqual({ x: 0.9, y: 0.8 });
  });
});

describe("applyGradientHandle", () => {
  const base = makeGradientPaint().gradient!; // linear, angle 90

  it("sets linear endpoints", () => {
    const geo = gradientGeometry(base);
    expect(
      applyGradientHandle("start", base, geo, { x: 0.1, y: 0.2 }).start
    ).toEqual({ x: 0.1, y: 0.2 });
    expect(
      applyGradientHandle("end", base, geo, { x: 0.9, y: 0.8 }).end
    ).toEqual({ x: 0.9, y: 0.8 });
  });

  it("carries the focal along when dragging the center", () => {
    const g = {
      ...base,
      kind: "radial" as const,
      center: { x: 0.5, y: 0.5 },
      focal: { x: 0.6, y: 0.5 }, // +0.1 offset in x
    };
    const out = applyGradientHandle("center", g, gradientGeometry(g), {
      x: 0.3,
      y: 0.4,
    });
    expect(out.center).toEqual({ x: 0.3, y: 0.4 });
    expect(out.focal!.x).toBeCloseTo(0.4, 5); // offset preserved
    expect(out.focal!.y).toBeCloseTo(0.4, 5);
  });

  it("sets radius from the horizontal distance, with a floor", () => {
    const g = { ...base, kind: "radial" as const, center: { x: 0.5, y: 0.5 } };
    const geo = gradientGeometry(g);
    expect(
      applyGradientHandle("radius", g, geo, { x: 0.8, y: 0.5 }).radius
    ).toBeCloseTo(0.3, 5);
    // Dragging onto the center floors the radius rather than collapsing to 0.
    expect(applyGradientHandle("radius", g, geo, { x: 0.5, y: 0.5 }).radius).toBe(
      0.02
    );
  });

  it("sets the focal point directly", () => {
    const g = { ...base, kind: "radial" as const };
    expect(
      applyGradientHandle("focal", g, gradientGeometry(g), { x: 0.2, y: 0.3 })
        .focal
    ).toEqual({ x: 0.2, y: 0.3 });
  });
});

describe("moveFreeformPoint", () => {
  it("moves only the targeted point", () => {
    const g = {
      ...makeGradientPaint().gradient!,
      kind: "freeform" as const,
      points: [
        { id: "a", point: { x: 0.2, y: 0.2 }, color: "#ffffff", opacity: 1 },
        { id: "b", point: { x: 0.8, y: 0.8 }, color: "#000000", opacity: 1 },
      ],
    };
    const out = moveFreeformPoint(g, "b", { x: 0.5, y: 0.4 });
    expect(out.points!.find((p) => p.id === "a")!.point).toEqual({
      x: 0.2,
      y: 0.2,
    });
    expect(out.points!.find((p) => p.id === "b")!.point).toEqual({
      x: 0.5,
      y: 0.4,
    });
  });

  it("moves a line stop (ids are unique across the gradient)", () => {
    const g = {
      ...makeGradientPaint().gradient!,
      kind: "freeform" as const,
      freeformMode: "lines" as const,
      lines: [
        {
          id: "l",
          stops: [
            { id: "a", point: { x: 0.2, y: 0.2 }, color: "#ffffff", opacity: 1 },
            { id: "b", point: { x: 0.8, y: 0.8 }, color: "#000000", opacity: 1 },
          ],
        },
      ],
    };
    const out = moveFreeformPoint(g, "b", { x: 0.5, y: 0.5 });
    expect(out.lines![0]!.stops.find((s) => s.id === "b")!.point).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(out.lines![0]!.stops.find((s) => s.id === "a")!.point).toEqual({
      x: 0.2,
      y: 0.2,
    });
  });
});

describe("moveMeshPoint", () => {
  it("moves only the targeted node", () => {
    const g = { ...makeGradientPaint().gradient!, kind: "mesh" as const, mesh: makeMesh() };
    const before = g.mesh.points[0]!.point;
    const out = moveMeshPoint(g, 3, { x: 0.4, y: 0.6 });
    expect(out.mesh!.points[3]!.point).toEqual({ x: 0.4, y: 0.6 });
    expect(out.mesh!.points[0]!.point).toEqual(before); // others untouched
  });

  it("clamps the position to the box", () => {
    const g = { ...makeGradientPaint().gradient!, kind: "mesh" as const, mesh: makeMesh() };
    const out = moveMeshPoint(g, 1, { x: 1.8, y: -0.5 });
    expect(out.mesh!.points[1]!.point).toEqual({ x: 1, y: 0 });
  });

  it("ignores an out-of-range index", () => {
    const g = { ...makeGradientPaint().gradient!, kind: "mesh" as const, mesh: makeMesh() };
    expect(moveMeshPoint(g, 99, { x: 0.5, y: 0.5 })).toBe(g);
  });
});
