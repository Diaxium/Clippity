import { describe, expect, it } from "vitest";

import {
  arrowPoints,
  spotlightBands,
  toDrawRect,
  wrapText,
  type DrawRect,
} from "./drawAnnotations";

/**
 * These cover the geometry rather than the painting.
 *
 * jsdom has no canvas rasteriser, so asserting on pixels here would mean
 * asserting on a mock — which tests the mock. What is worth pinning is
 * the arithmetic that decides *where* things go, because each of these
 * has a failure that looks like a rendering glitch and is really a
 * one-line mistake: a spotlight band a pixel short leaves a bright seam,
 * an arrow diagonal reversed points the wrong way.
 */

const area = (r: DrawRect) => r.w * r.h;

describe("toDrawRect", () => {
  it("scales a normalised rect onto the target", () => {
    expect(toDrawRect({ x: 0.5, y: 0.25, w: 0.25, h: 0.5 }, 800, 400)).toEqual({
      x: 400,
      y: 100,
      w: 200,
      h: 200,
    });
  });

  it("gives the same rect at any scale, proportionally", () => {
    // The property that lets one renderer serve the preview and a
    // 5120-wide export: geometry is a fraction, never a pixel count.
    const small = toDrawRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 100, 100);
    const large = toDrawRect({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, 1_000, 1_000);
    expect(large.x).toBeCloseTo(small.x * 10);
    expect(large.w).toBeCloseTo(small.w * 10);
  });
});

describe("spotlightBands", () => {
  it("covers everything outside the rect and nothing inside it", () => {
    const width = 100;
    const height = 50;
    const rect: DrawRect = { x: 20, y: 10, w: 40, h: 20 };
    const bands = spotlightBands(rect, width, height);

    // The bands must tile the frame minus the hole exactly — a shortfall
    // is a bright seam, an excess is a band over the spotlight itself.
    const covered = bands.reduce((sum, band) => sum + area(band), 0);
    expect(covered).toBe(width * height - area(rect));

    for (const band of bands) {
      const overlapsX = band.x < rect.x + rect.w && band.x + band.w > rect.x;
      const overlapsY = band.y < rect.y + rect.h && band.y + band.h > rect.y;
      expect(overlapsX && overlapsY).toBe(false);
    }
  });

  it("produces no bands when the rect fills the frame", () => {
    expect(spotlightBands({ x: 0, y: 0, w: 100, h: 50 }, 100, 50)).toEqual([]);
  });

  it("covers the whole frame when the rect is off it entirely", () => {
    const bands = spotlightBands({ x: 200, y: 200, w: 10, h: 10 }, 100, 50);
    expect(bands.reduce((sum, band) => sum + area(band), 0)).toBe(100 * 50);
  });

  it("never emits a negative band for a rect hanging off the edge", () => {
    // fillRect draws a negative rectangle mirrored, so this would paint
    // a dark band across the picture rather than nothing.
    for (const rect of [
      { x: -50, y: -50, w: 40, h: 40 },
      { x: 80, y: 40, w: 100, h: 100 },
      { x: -10, y: -10, w: 200, h: 200 },
    ]) {
      for (const band of spotlightBands(rect, 100, 50)) {
        expect(band.w).toBeGreaterThan(0);
        expect(band.h).toBeGreaterThan(0);
      }
    }
  });
});

describe("arrowPoints", () => {
  const rect: DrawRect = { x: 10, y: 20, w: 100, h: 40 };

  it("runs along the diagonal its corner names", () => {
    expect(arrowPoints(rect, "topLeft")).toEqual({
      fromX: 10,
      fromY: 20,
      toX: 110,
      toY: 60,
    });
    expect(arrowPoints(rect, "bottomRight")).toEqual({
      fromX: 110,
      fromY: 60,
      toX: 10,
      toY: 20,
    });
  });

  it("gives opposite corners opposite directions", () => {
    // Pins the pairing, which is the part that is easy to transpose.
    const a = arrowPoints(rect, "topRight");
    const b = arrowPoints(rect, "bottomLeft");
    expect([a.fromX, a.fromY]).toEqual([b.toX, b.toY]);
    expect([a.toX, a.toY]).toEqual([b.fromX, b.fromY]);
  });

  it("always spans the full rect, whichever corner it starts from", () => {
    for (const corner of [
      "topLeft",
      "topRight",
      "bottomLeft",
      "bottomRight",
    ] as const) {
      const p = arrowPoints(rect, corner);
      expect(Math.abs(p.toX - p.fromX)).toBe(rect.w);
      expect(Math.abs(p.toY - p.fromY)).toBe(rect.h);
    }
  });
});

describe("wrapText", () => {
  /** One unit per character, so the expected wrap is readable here. */
  const measure = (s: string) => s.length;

  it("breaks on words to fit the width", () => {
    expect(wrapText("the quick brown fox", 10, measure)).toEqual([
      "the quick",
      "brown fox",
    ]);
  });

  it("keeps text that already fits on one line", () => {
    expect(wrapText("short", 100, measure)).toEqual(["short"]);
  });

  it("honours explicit newlines", () => {
    expect(wrapText("one\ntwo", 100, measure)).toEqual(["one", "two"]);
  });

  it("lets a word longer than the line overflow rather than splitting it", () => {
    // Hyphenating at an arbitrary character reads as corruption, and a
    // label is short by nature.
    expect(wrapText("antidisestablishmentarianism", 5, measure)).toEqual([
      "antidisestablishmentarianism",
    ]);
  });

  it("collapses runs of whitespace", () => {
    expect(wrapText("a   b", 100, measure)).toEqual(["a b"]);
  });

  it("returns a single empty line for empty text", () => {
    // The caller draws one blank line rather than nothing, so an
    // annotation being typed into does not flicker out of existence.
    expect(wrapText("", 100, measure)).toEqual([""]);
    expect(wrapText("   ", 100, measure)).toEqual([""]);
  });
});
