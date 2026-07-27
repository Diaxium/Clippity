import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeImage,
  makeLine,
  makeStroke,
  type ChromeSpec,
} from "../types";
import { rotatedAABB } from "../geometry";
import {
  exportBounds,
  formatIsOpaque,
  formatMime,
  type ExportFormat,
} from "./render";

/**
 * `flattenScene` itself is not unit-tested: jsdom has no Canvas 2D context, so
 * every pixel path in this module is verified by eyeball in the app (see the
 * test convention in the editor roadmap). These are the pure format helpers
 * that decide *how* the canvas is encoded, which are testable in isolation.
 */

const ALL: readonly ExportFormat[] = ["png", "jpeg", "webp"];

describe("export format helpers", () => {
  it("maps each format to its canvas MIME type", () => {
    expect(formatMime("png")).toBe("image/png");
    // JPG's MIME subtype is "jpeg" — the canvas rejects "image/jpg".
    expect(formatMime("jpeg")).toBe("image/jpeg");
    expect(formatMime("webp")).toBe("image/webp");
  });

  it("flags only JPEG as alpha-less", () => {
    // JPEG has no alpha channel, so an export has to be matted or the
    // encoder turns transparent pixels black.
    expect(formatIsOpaque("jpeg")).toBe(true);
    expect(formatIsOpaque("png")).toBe(false);
    expect(formatIsOpaque("webp")).toBe(false);
  });

  it("produces an image/* MIME the backend can parse for every format", () => {
    // The backend derives the saved file's extension from this MIME, so a
    // format the panel offers must always yield a well-formed one.
    for (const f of ALL) expect(formatMime(f)).toBe(`image/${f}`);
  });
});

describe("exportBounds", () => {
  const BOX = { x: 0, y: 0, width: 800, height: 500 };
  const BAR: ChromeSpec = {
    style: "macos",
    height: 36,
    color: "#e8e6e6",
    title: "",
  };

  function capture(chrome: ChromeSpec | null, rotation = 0) {
    __resetNodeIdForTests();
    const n = makeImage(BOX, "data:image/png;base64,AA");
    n.chrome = chrome;
    n.rotation = rotation;
    return n;
  }

  it("is the node's own box without chrome", () => {
    expect(exportBounds(capture(null))).toEqual(BOX);
  });

  it("grows upward by the bar, so a one-node export doesn't slice it off", () => {
    // `rotatedAABB` measures the node's *frame*, but a chromed node draws a
    // title bar above it — exporting the capture alone would otherwise crop it.
    expect(exportBounds(capture(BAR))).toEqual({
      x: 0,
      y: -36,
      width: 800,
      height: 536,
    });
  });

  it("grows around a dimension's caps and label, which hang off its segment", () => {
    // A horizontal line's frame is zero-height, so `rotatedAABB` alone would
    // size a one-node export to a 1px strip and crop the whole mark away —
    // the same trap window chrome hit, from a second direction.
    __resetNodeIdForTests();
    const n = makeLine(
      { x: 100, y: 200, width: 600, height: 0 },
      { strokes: [makeStroke("#f24822", 2)] }
    );
    expect(rotatedAABB(n).height).toBe(0);
    n.measure = { caps: "tick", scale: 1, unit: "px" };
    const b = exportBounds(n);
    expect(b.height).toBeGreaterThan(20);
    expect(b.x).toBeLessThanOrEqual(100);
    expect(b.x + b.width).toBeGreaterThanOrEqual(700);
  });

  it("rotates the window about the node's centre, not the window's", () => {
    // That's the transform both renderers apply to the whole group, bar
    // included — and the distinction is observable. The window's centre sits
    // half a bar (18px) *above* the node's; a quarter turn clockwise about the
    // node's centre therefore lands it 18px to the **right**, not back on the
    // node's centre as rotating about the window's own centre would.
    const b = exportBounds(capture(BAR, 90));
    expect(b.width).toBeCloseTo(536);
    expect(b.height).toBeCloseTo(800);
    expect(b.x + b.width / 2).toBeCloseTo(BOX.width / 2 + 18);
    expect(b.y + b.height / 2).toBeCloseTo(BOX.height / 2);
  });
});
