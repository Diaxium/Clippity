import { describe, expect, it } from "vitest";

import {
  freeformAllSources,
  freeformColorAt,
  freeformSources,
  lineSources,
} from "./freeform";
import type { FreeformSource } from "./freeform";
import { makeGradientPaint, type GradientPaint } from "../types";

const red: FreeformSource = { x: 0, y: 0, r: 255, g: 0, b: 0, a: 255 };
const blue: FreeformSource = { x: 10, y: 0, r: 0, g: 0, b: 255, a: 255 };

describe("freeformColorAt", () => {
  it("is transparent with no sources", () => {
    expect(freeformColorAt([], 5, 5)).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("returns a single source's color everywhere", () => {
    const c = freeformColorAt([red], 50, 80);
    expect(c.r).toBeCloseTo(255, 3);
    expect(c.b).toBeCloseTo(0, 3);
    expect(c.a).toBeCloseTo(255, 3);
  });

  it("is dominated by the nearest source", () => {
    // Sitting on the red source → essentially red.
    const c = freeformColorAt([red, blue], 0, 0);
    expect(c.r).toBeGreaterThan(250);
    expect(c.b).toBeLessThan(5);
  });

  it("blends evenly at the midpoint of two equal sources", () => {
    const c = freeformColorAt([red, blue], 5, 0); // equidistant
    expect(c.r).toBeCloseTo(127.5, 0);
    expect(c.b).toBeCloseTo(127.5, 0);
  });
});

describe("freeformSources", () => {
  it("maps normalized points into the pixel grid", () => {
    const [s] = freeformSources(
      [{ id: "a", point: { x: 0.5, y: 0.25 }, color: "#ff0000", opacity: 0.5 }],
      100,
      80
    );
    expect(s).toMatchObject({ x: 50, y: 20, r: 255, g: 0, b: 0 });
    expect(s!.a).toBeCloseTo(127.5, 1);
  });
});

describe("lineSources", () => {
  it("samples a line into many interpolated sources", () => {
    const sources = lineSources(
      [
        {
          id: "l",
          stops: [
            { id: "a", point: { x: 0, y: 0.5 }, color: "#ff0000", opacity: 1 },
            { id: "b", point: { x: 1, y: 0.5 }, color: "#0000ff", opacity: 1 },
          ],
        },
      ],
      40,
      40
    );
    expect(sources.length).toBeGreaterThan(2); // sampled, not just endpoints
    expect(sources[0]).toMatchObject({ r: 255, b: 0 }); // start = red
    expect(sources[sources.length - 1]).toMatchObject({ r: 0, b: 255 }); // end
    const mid = sources[Math.floor(sources.length / 2)]!;
    expect(mid.r).toBeGreaterThan(0); // blends through the middle
    expect(mid.r).toBeLessThan(255);
  });
});

describe("freeformAllSources", () => {
  function gp(extra: Partial<GradientPaint>): GradientPaint {
    return {
      ...makeGradientPaint().gradient!,
      kind: "freeform",
      points: [
        { id: "p", point: { x: 0.5, y: 0.5 }, color: "#ff0000", opacity: 1 },
      ],
      lines: [
        {
          id: "l",
          stops: [
            { id: "a", point: { x: 0, y: 0 }, color: "#00ff00", opacity: 1 },
            { id: "b", point: { x: 1, y: 1 }, color: "#00ff00", opacity: 1 },
          ],
        },
      ],
      ...extra,
    };
  }

  it("uses points by default and lines in lines mode", () => {
    expect(
      freeformAllSources(gp({ freeformMode: "points" }), 40, 40)
    ).toHaveLength(1);
    expect(
      freeformAllSources(gp({ freeformMode: "lines" }), 40, 40).length
    ).toBeGreaterThan(1);
  });
});
