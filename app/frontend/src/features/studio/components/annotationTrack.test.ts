import { describe, expect, it } from "vitest";

import { packRows } from "./AnnotationTrack";
import type { Annotation } from "@clippity/shared";

function bar(startMs: number, endMs: number): Annotation {
  return {
    id: `${startMs}-${endMs}`,
    kind: "box",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    color: "#f00",
    filled: false,
    strokeWidth: 0.01,
    startMs,
    endMs,
  };
}

/**
 * The failure this guards looks like a rendering bug and is really a
 * packing one: two bars assigned the same row overlap on screen, and the
 * one underneath cannot be clicked.
 */
describe("packRows", () => {
  it("keeps non-overlapping annotations on one row", () => {
    // The common case, and the reason to pack at all — a lane per
    // annotation would grow the timeline for no benefit.
    expect(
      packRows([bar(0, 1_000), bar(1_000, 2_000), bar(2_000, 3_000)])
    ).toEqual([0, 0, 0]);
  });

  it("moves an overlapping annotation to the next row", () => {
    expect(packRows([bar(0, 2_000), bar(1_000, 3_000)])).toEqual([0, 1]);
  });

  it("reuses a row once its last bar has ended", () => {
    // First-fit: the third bar starts after the first ends, so it goes
    // back to row 0 rather than opening a third row.
    expect(
      packRows([bar(0, 1_000), bar(500, 1_500), bar(1_000, 2_000)])
    ).toEqual([0, 1, 0]);
  });

  it("gives every annotation a row", () => {
    const bars = [bar(0, 5_000), bar(0, 5_000), bar(0, 5_000)];
    expect(packRows(bars)).toEqual([0, 1, 2]);
  });

  it("treats a touching boundary as non-overlapping", () => {
    // Ranges are half-open, so one ending exactly where the next begins
    // never share a frame and can share a row.
    expect(packRows([bar(0, 1_000), bar(1_000, 2_000)])).toEqual([0, 0]);
  });

  it("has nothing to pack for an empty lane", () => {
    expect(packRows([])).toEqual([]);
  });
});
