import { describe, expect, it } from "vitest";

import {
  fullRange,
  isTrimmed,
  MIN_TRIM_MS,
  moveRange,
  nextPlayheadWithinRange,
  rangeDurationMs,
  resolveHandleDrag,
  snapToEdges,
  type TrimRange,
} from "./trim";

const DURATION = 10_000;

describe("fullRange", () => {
  it("is the whole clip", () => {
    expect(fullRange(DURATION)).toEqual({ startMs: 0, endMs: DURATION });
    expect(isTrimmed(fullRange(DURATION), DURATION)).toBe(false);
  });
});

describe("resolveHandleDrag", () => {
  const range: TrimRange = { startMs: 2_000, endMs: 8_000 };

  it("moves the dragged handle and leaves the other alone", () => {
    expect(resolveHandleDrag(range, "in", 3_000, DURATION)).toEqual({
      startMs: 3_000,
      endMs: 8_000,
    });
    expect(resolveHandleDrag(range, "out", 6_000, DURATION)).toEqual({
      startMs: 2_000,
      endMs: 6_000,
    });
  });

  it("stops the in-point short of the out-point rather than crossing it", () => {
    const dragged = resolveHandleDrag(range, "in", 9_999, DURATION);
    expect(dragged.startMs).toBe(8_000 - MIN_TRIM_MS);
    expect(dragged.endMs).toBe(8_000);
  });

  it("stops the out-point short of the in-point rather than crossing it", () => {
    const dragged = resolveHandleDrag(range, "out", 0, DURATION);
    expect(dragged.endMs).toBe(2_000 + MIN_TRIM_MS);
    expect(dragged.startMs).toBe(2_000);
  });

  it("never lets a drag produce a range the backend would refuse", () => {
    // The whole point of the stop: the export button must never be
    // disabled for a reason the timeline didn't show.
    for (const target of [-5_000, 0, 4_000, 8_000, 50_000]) {
      for (const handle of ["in", "out"] as const) {
        const next = resolveHandleDrag(range, handle, target, DURATION);
        expect(rangeDurationMs(next)).toBeGreaterThanOrEqual(MIN_TRIM_MS);
      }
    }
  });

  it("holds a handle inside the clip", () => {
    expect(resolveHandleDrag(range, "in", -1_000, DURATION).startMs).toBe(0);
    expect(resolveHandleDrag(range, "out", 99_999, DURATION).endMs).toBe(
      DURATION
    );
  });

  it("does not propose a negative start on a clip shorter than the minimum", () => {
    // A pathological source, but the arithmetic must not produce a
    // negative position for the scrubber to render.
    const tiny = 100;
    const next = resolveHandleDrag({ startMs: 0, endMs: tiny }, "in", 90, tiny);
    expect(next.startMs).toBeGreaterThanOrEqual(0);
  });
});

describe("moveRange", () => {
  const range: TrimRange = { startMs: 2_000, endMs: 5_000 };

  it("slides without changing the length", () => {
    const moved = moveRange(range, 1_000, DURATION);
    expect(moved).toEqual({ startMs: 3_000, endMs: 6_000 });
    expect(rangeDurationMs(moved)).toBe(rangeDurationMs(range));
  });

  it("parks flush against the end rather than being squashed shorter", () => {
    const moved = moveRange(range, 99_999, DURATION);
    expect(moved.endMs).toBe(DURATION);
    expect(rangeDurationMs(moved)).toBe(rangeDurationMs(range));
  });

  it("parks flush against the start", () => {
    const moved = moveRange(range, -99_999, DURATION);
    expect(moved.startMs).toBe(0);
    expect(rangeDurationMs(moved)).toBe(rangeDurationMs(range));
  });
});

describe("isTrimmed", () => {
  it("is true as soon as either end has moved", () => {
    expect(isTrimmed({ startMs: 1, endMs: DURATION }, DURATION)).toBe(true);
    expect(isTrimmed({ startMs: 0, endMs: DURATION - 1 }, DURATION)).toBe(true);
    expect(isTrimmed({ startMs: 0, endMs: DURATION }, DURATION)).toBe(false);
  });
});

describe("nextPlayheadWithinRange", () => {
  const range: TrimRange = { startMs: 2_000, endMs: 5_000 };

  it("leaves a playhead inside the range alone", () => {
    expect(nextPlayheadWithinRange(3_000, range)).toBeNull();
  });

  it("pulls a playhead before the in-point up to it", () => {
    expect(nextPlayheadWithinRange(500, range)).toBe(2_000);
  });

  it("loops back to the in-point at the out-point", () => {
    // Playing a trim should preview the trim — running past the
    // out-point shows footage the export will not contain.
    expect(nextPlayheadWithinRange(5_000, range)).toBe(2_000);
    expect(nextPlayheadWithinRange(9_000, range)).toBe(2_000);
  });
});

describe("snapToEdges", () => {
  const range: TrimRange = { startMs: 2_000, endMs: 5_000 };

  it("snaps to an edge inside the tolerance", () => {
    expect(snapToEdges(2_040, range, 100)).toBe(2_000);
    expect(snapToEdges(4_950, range, 100)).toBe(5_000);
  });

  it("leaves a position outside the tolerance untouched", () => {
    expect(snapToEdges(3_500, range, 100)).toBe(3_500);
  });

  it("prefers the nearer edge when both are in range", () => {
    const tight: TrimRange = { startMs: 1_000, endMs: 1_100 };
    expect(snapToEdges(1_090, tight, 500)).toBe(1_100);
    expect(snapToEdges(1_010, tight, 500)).toBe(1_000);
  });
});
