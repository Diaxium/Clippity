import { describe, expect, it, vi } from "vitest";

import { renderOverlays, type CanvasFactory } from "./exportOverlays";
import type { Annotation } from "@clippity/shared";

/**
 * jsdom has no canvas rasteriser, so these check the *orchestration*:
 * how many overlays an export produces, at what size, and over which
 * spans. What lands on the pixels is `drawAnnotations`, which is the
 * same function the preview calls — which is the whole point, and is
 * covered by its own tests.
 */

/** A canvas stub recording the calls that matter. */
function stubCanvas(): {
  factory: CanvasFactory;
  made: Array<[number, number]>;
} {
  const made: Array<[number, number]> = [];
  const factory: CanvasFactory = (width, height) => {
    made.push([width, height]);
    return {
      width,
      height,
      getContext: () => ({
        clearRect: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        closePath: vi.fn(),
        stroke: vi.fn(),
        fill: vi.fn(),
        fillText: vi.fn(),
        measureText: () => ({ width: 10 }),
      }),
      toDataURL: () => "data:image/png;base64,UE5H",
    } as unknown as HTMLCanvasElement;
  };
  return { factory, made };
}

function box(id: string, startMs: number, endMs: number): Annotation {
  return {
    id,
    kind: "box",
    rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    color: "#f00",
    filled: false,
    strokeWidth: 0.01,
    startMs,
    endMs,
  };
}

const opts = (extra: Partial<Parameters<typeof renderOverlays>[1]> = {}) => {
  const { factory } = stubCanvas();
  return {
    width: 1920,
    height: 1080,
    fromMs: 0,
    toMs: 10_000,
    stage: vi.fn(async () => "C:/tmp/o.png"),
    canvasFactory: factory,
    ...extra,
  };
};

describe("renderOverlays", () => {
  it("stages one overlay per interval, not per frame", () => {
    // The property the whole burn-in design rests on.
    const options = opts();
    return renderOverlays(
      [box("a", 0, 4_000), box("b", 2_000, 6_000)],
      options
    ).then((refs) => {
      expect(refs).toHaveLength(3);
      expect(options.stage).toHaveBeenCalledTimes(3);
      expect(refs.map((r) => [r.startMs, r.endMs])).toEqual([
        [0, 2_000],
        [2_000, 4_000],
        [4_000, 6_000],
      ]);
    });
  });

  it("stages nothing when there are no drawn annotations", async () => {
    // The encoder then skips compositing entirely.
    const options = opts();
    expect(await renderOverlays([], options)).toEqual([]);
    expect(options.stage).not.toHaveBeenCalled();

    const blurOnly: Annotation = {
      id: "b",
      kind: "blur",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      radius: 8,
      startMs: 0,
      endMs: 5_000,
    };
    expect(await renderOverlays([blurOnly], opts())).toEqual([]);
  });

  it("renders at the source frame size", async () => {
    // A mismatch means the backend composites only the overlap, so the
    // annotation would be cropped in the exported file.
    const { factory, made } = stubCanvas();
    await renderOverlays(
      [box("a", 0, 1_000)],
      opts({ canvasFactory: factory })
    );
    expect(made).toEqual([[1920, 1080]]);
  });

  it("reuses one canvas across intervals", async () => {
    // A fresh 5120×1440 canvas per interval would cost far more than it
    // saves; `drawAnnotations` clears before drawing, so there is
    // nothing to carry over.
    const { factory, made } = stubCanvas();
    await renderOverlays(
      [box("a", 0, 4_000), box("b", 2_000, 6_000)],
      opts({ canvasFactory: factory })
    );
    expect(made).toHaveLength(1);
  });

  it("strips the data-URL prefix before staging", async () => {
    // The backend base64-decodes what it is given and checks the PNG
    // signature; a `data:` prefix would fail that check.
    const options = opts();
    await renderOverlays([box("a", 0, 1_000)], options);
    expect(options.stage).toHaveBeenCalledWith("UE5H");
  });

  it("clips overlays to the exported range", async () => {
    // An annotation running past the out-point must not produce an
    // overlay span the export never reaches.
    const refs = await renderOverlays(
      [box("a", 0, 60_000)],
      opts({ fromMs: 2_000, toMs: 5_000 })
    );
    expect(refs).toEqual([
      { path: "C:/tmp/o.png", startMs: 2_000, endMs: 5_000 },
    ]);
  });
});
