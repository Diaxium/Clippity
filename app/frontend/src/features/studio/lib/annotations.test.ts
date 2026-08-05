import { describe, expect, it } from "vitest";

import {
  activeAt,
  clampRect,
  createAnnotation,
  hitTest,
  MIN_ANNOTATION_MS,
  moveAnnotationRange,
  moveRect,
  overlayIntervals,
  resizeRect,
  resolveAnnotationDrag,
  toRedactions,
} from "./annotations";
import type { Annotation } from "@clippity/shared";

const rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };

function box(id: string, startMs: number, endMs: number): Annotation {
  return {
    id,
    kind: "box",
    rect,
    color: "#f00",
    filled: false,
    strokeWidth: 0.01,
    startMs,
    endMs,
  };
}

function blur(id: string, startMs: number, endMs: number): Annotation {
  return { id, kind: "blur", rect, radius: 8, startMs, endMs };
}

describe("createAnnotation", () => {
  it("builds every kind with a usable range", () => {
    for (const kind of [
      "box",
      "spotlight",
      "text",
      "arrow",
      "pixelate",
      "blur",
    ] as const) {
      const annotation = createAnnotation(kind, 1_000);
      expect(annotation.kind).toBe(kind);
      expect(annotation.endMs).toBeGreaterThan(annotation.startMs);
      expect(annotation.id).not.toHaveLength(0);
    }
  });

  it("gives distinct ids", () => {
    const a = createAnnotation("box", 0);
    const b = createAnnotation("box", 0);
    expect(a.id).not.toBe(b.id);
  });

  it("never creates a range too short to grab", () => {
    const annotation = createAnnotation("box", 0, 1);
    expect(annotation.endMs - annotation.startMs).toBe(MIN_ANNOTATION_MS);
  });
});

describe("activeAt", () => {
  it("returns only what is showing, in paint order", () => {
    const annotations = [box("a", 0, 1_000), box("b", 500, 2_000)];
    expect(activeAt(annotations, 100).map((a) => a.id)).toEqual(["a"]);
    expect(activeAt(annotations, 600).map((a) => a.id)).toEqual(["a", "b"]);
    expect(activeAt(annotations, 1_500).map((a) => a.id)).toEqual(["b"]);
    expect(activeAt(annotations, 5_000)).toEqual([]);
  });
});

describe("overlayIntervals", () => {
  it("cuts the clip where the drawn set changes", () => {
    // Two overlapping boxes: three spans, and the gap after both end
    // produces none.
    const intervals = overlayIntervals(
      [box("a", 0, 1_000), box("b", 500, 2_000)],
      0,
      3_000
    );
    expect(intervals).toEqual([
      { startMs: 0, endMs: 500 },
      { startMs: 500, endMs: 1_000 },
      { startMs: 1_000, endMs: 2_000 },
    ]);
  });

  it("omits spans where nothing is showing", () => {
    // An empty overlay is a full-resolution transparent PNG rendered,
    // encoded, staged and blended to change nothing.
    const intervals = overlayIntervals([box("a", 1_000, 2_000)], 0, 3_000);
    expect(intervals).toEqual([{ startMs: 1_000, endMs: 2_000 }]);
  });

  it("ignores pixel-filter annotations entirely", () => {
    // They cross as parameters, so a blur boundary would only cost an
    // extra bitmap that draws nothing.
    expect(overlayIntervals([blur("a", 0, 1_000)], 0, 3_000)).toEqual([]);
    expect(
      overlayIntervals([box("a", 0, 3_000), blur("b", 1_000, 2_000)], 0, 3_000)
    ).toEqual([{ startMs: 0, endMs: 3_000 }]);
  });

  it("clips to the requested window", () => {
    // An annotation running past the trim's out-point must not extend
    // the export's overlay list past the end of the export.
    const intervals = overlayIntervals([box("a", 0, 10_000)], 2_000, 5_000);
    expect(intervals).toEqual([{ startMs: 2_000, endMs: 5_000 }]);
  });

  it("stays bounded by the number of annotations, not the duration", () => {
    // The property the whole design rests on: overlays scale with how
    // many annotations there are, never with how long the clip is.
    const annotations = Array.from({ length: 6 }, (_, i) =>
      box(`a${i}`, i * 1_000, i * 1_000 + 2_500)
    );
    const short = overlayIntervals(annotations, 0, 60_000);
    const long = overlayIntervals(annotations, 0, 3_600_000);
    expect(short.length).toBe(long.length);
    expect(short.length).toBeLessThanOrEqual(2 * annotations.length + 1);
  });

  it("has nothing to render for an empty or inverted window", () => {
    expect(overlayIntervals([], 0, 1_000)).toEqual([]);
    expect(overlayIntervals([box("a", 0, 1_000)], 1_000, 1_000)).toEqual([]);
    expect(overlayIntervals([box("a", 0, 1_000)], 2_000, 1_000)).toEqual([]);
  });
});

describe("toRedactions", () => {
  it("emits the flattened, mode-tagged shape Rust expects", () => {
    const wire = toRedactions([
      blur("a", 0, 1_000),
      { id: "b", kind: "pixelate", rect, block: 12, startMs: 5, endMs: 9 },
      box("c", 0, 1_000),
    ]);
    expect(wire).toEqual([
      { rect, startMs: 0, endMs: 1_000, mode: "blur", radius: 8 },
      { rect, startMs: 5, endMs: 9, mode: "pixelate", block: 12 },
    ]);
  });

  it("drops the drawn kinds, which travel as overlays", () => {
    expect(toRedactions([box("a", 0, 1_000)])).toEqual([]);
  });
});

describe("hitTest", () => {
  it("picks the topmost annotation under the point", () => {
    // Back to front, so the answer matches what the user sees on top.
    const annotations = [box("under", 0, 1_000), box("over", 0, 1_000)];
    expect(hitTest(annotations, 0.3, 0.3, 500)?.id).toBe("over");
  });

  it("ignores annotations not showing at that moment", () => {
    expect(hitTest([box("a", 2_000, 3_000)], 0.3, 0.3, 500)).toBeNull();
  });

  it("returns null outside every rect", () => {
    expect(hitTest([box("a", 0, 1_000)], 0.9, 0.9, 500)).toBeNull();
  });
});

describe("resolveAnnotationDrag", () => {
  const a = box("a", 2_000, 6_000);

  it("moves the dragged edge and leaves the other alone", () => {
    expect(resolveAnnotationDrag(a, "start", 3_000, 10_000)).toEqual({
      startMs: 3_000,
      endMs: 6_000,
    });
    expect(resolveAnnotationDrag(a, "end", 8_000, 10_000)).toEqual({
      startMs: 2_000,
      endMs: 8_000,
    });
  });

  it("never lets the two ends cross or meet", () => {
    // An inverted or zero-length annotation cannot be grabbed again to
    // fix it, so the resolver refuses to produce one.
    const pulled = resolveAnnotationDrag(a, "start", 9_999, 10_000);
    expect(pulled.endMs - pulled.startMs).toBeGreaterThanOrEqual(
      MIN_ANNOTATION_MS
    );

    const pushed = resolveAnnotationDrag(a, "end", 0, 10_000);
    expect(pushed.endMs - pushed.startMs).toBeGreaterThanOrEqual(
      MIN_ANNOTATION_MS
    );
  });

  it("keeps the range inside the clip", () => {
    const past = resolveAnnotationDrag(a, "end", 99_000, 10_000);
    expect(past.endMs).toBe(10_000);

    const before = resolveAnnotationDrag(a, "start", -5_000, 10_000);
    expect(before.startMs).toBe(0);
  });
});

describe("moveAnnotationRange", () => {
  it("slides the range and keeps its length", () => {
    expect(moveAnnotationRange(box("a", 1_000, 3_000), 500, 10_000)).toEqual({
      startMs: 1_500,
      endMs: 3_500,
    });
  });

  it("parks at the ends rather than squashing", () => {
    const at = box("a", 1_000, 3_000);
    expect(moveAnnotationRange(at, -9_000, 10_000)).toEqual({
      startMs: 0,
      endMs: 2_000,
    });
    expect(moveAnnotationRange(at, 99_000, 10_000)).toEqual({
      startMs: 8_000,
      endMs: 10_000,
    });
  });

  it("does not go negative on a clip shorter than the annotation", () => {
    const moved = moveAnnotationRange(box("a", 0, 8_000), -100, 5_000);
    expect(moved.startMs).toBe(0);
  });
});

describe("clampRect", () => {
  it("keeps a rect on the frame", () => {
    expect(clampRect({ x: -0.5, y: 1.4, w: 0.3, h: 0.2 })).toEqual({
      x: 0,
      y: 0.8,
      w: 0.3,
      h: 0.2,
    });
  });

  it("never collapses a rect to nothing", () => {
    // A zero-sized annotation cannot be grabbed again to fix it.
    const clamped = clampRect({ x: 0.5, y: 0.5, w: 0, h: -1 });
    expect(clamped.w).toBeGreaterThan(0);
    expect(clamped.h).toBeGreaterThan(0);
  });
});

describe("moveRect", () => {
  it("slides along an edge rather than squashing against it", () => {
    const moved = moveRect({ x: 0.9, y: 0.5, w: 0.2, h: 0.2 }, 0.5, 0);
    expect(moved.w).toBe(0.2);
    expect(moved.x).toBeCloseTo(0.8);
  });
});

describe("resizeRect", () => {
  it("moves the dragged corner and leaves the opposite one alone", () => {
    const resized = resizeRect(
      { x: 0.2, y: 0.2, w: 0.4, h: 0.4 },
      "se",
      0.8,
      0.7
    );
    expect(resized.x).toBeCloseTo(0.2);
    expect(resized.y).toBeCloseTo(0.2);
    expect(resized.w).toBeCloseTo(0.6);
    expect(resized.h).toBeCloseTo(0.5);
  });

  it("flips rather than producing a negative size", () => {
    // A negative rect renders mirrored and hit-tests as empty, so
    // dragging a corner past its opposite has to fold the rectangle.
    const resized = resizeRect(
      { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      "nw",
      0.8,
      0.9
    );
    expect(resized.w).toBeGreaterThan(0);
    expect(resized.h).toBeGreaterThan(0);
    expect(resized.x).toBeCloseTo(0.6);
  });
});
