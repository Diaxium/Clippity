import { describe, expect, it } from "vitest";

import { MIN_EDGE_MAG, sobelAt, strongestEdge } from "./edges";

/** Build a `w × h` luminance buffer with a hard vertical edge: columns
 *  `< edgeX` dark (0), columns `>= edgeX` bright (255). */
function verticalEdge(w: number, h: number, edgeX: number): number[] {
  const lum: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) lum.push(x >= edgeX ? 255 : 0);
  }
  return lum;
}

describe("sobelAt", () => {
  const w = 9;
  const h = 9;
  const lum = verticalEdge(w, h, 5);

  it("is ~0 in a flat region", () => {
    expect(sobelAt(lum, w, h, 2, 4)).toBe(0);
    expect(sobelAt(lum, w, h, 7, 4)).toBe(0);
  });

  it("is strong straddling the edge", () => {
    // Column 4 straddles the 0→255 transition at x=5.
    expect(sobelAt(lum, w, h, 4, 4)).toBeGreaterThan(MIN_EDGE_MAG);
  });

  it("returns 0 on the 1px border (no neighbours)", () => {
    expect(sobelAt(lum, w, h, 0, 0)).toBe(0);
    expect(sobelAt(lum, w, h, w - 1, 4)).toBe(0);
  });
});

describe("strongestEdge", () => {
  const w = 11;
  const h = 11;
  const lum = verticalEdge(w, h, 6);

  it("snaps a cursor near the edge onto the edge column", () => {
    // Cursor at x=8 (flat bright side), search radius 4 → should snap
    // left onto the transition near x=5.
    const best = strongestEdge(lum, w, h, 8, 5, 4);
    expect(best).not.toBeNull();
    expect(best!.x).toBeLessThanOrEqual(6);
    expect(best!.x).toBeGreaterThanOrEqual(4);
    expect(best!.mag).toBeGreaterThan(MIN_EDGE_MAG);
  });

  it("returns null when no edge is within reach", () => {
    // A flat buffer has no gradient anywhere.
    const flat = new Array(w * h).fill(128);
    expect(strongestEdge(flat, w, h, 5, 5, 3)).toBeNull();
  });

  it("prefers the closer of two comparable edges (proximity bias)", () => {
    // Two edges: at x=3 and x=8. Cursor at x=7 should snap to the x=8
    // edge region (closer), not the equally-strong x=3 one.
    const two: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = (x >= 3 && x < 8) ? 255 : 0;
        two.push(v);
      }
    }
    const best = strongestEdge(two, w, h, 7, 5, 4);
    expect(best).not.toBeNull();
    expect(best!.x).toBeGreaterThanOrEqual(6);
  });
});
