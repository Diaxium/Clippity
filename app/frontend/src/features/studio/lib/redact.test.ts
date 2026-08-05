import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyRedactions,
  boxBlur,
  MIN_PIXELATE_BLOCK,
  normToPixels,
  pixelate,
  roundDiv,
  type PixelRect,
} from "./redact";
import type { Annotation } from "@clippity/shared";

/**
 * The cross-language pin.
 *
 * `redact.ts` and Rust's `domain::annotation` are the only place in
 * Studio's annotations where the same operation is implemented twice —
 * everything else is drawn once, by canvas, for both the preview and the
 * export. Two implementations drift, and a drifted blur is invisible:
 * the preview shows one thing, the exported file contains another, and
 * nothing errors.
 *
 * So both sides run this fixture. Rust generates it (it is what writes
 * the exported file, so it is the reference) and asserts against it; the
 * tests below assert the preview produces the same bytes. A failure here
 * means the two halves disagree, and the fix is to make the preview
 * match — not to regenerate the fixture, which would only record the
 * disagreement.
 */
const FIXTURE_PATH = resolve(
  // Vitest runs with the package root as its working directory, which is
  // steadier here than `import.meta.url` — that is not a `file:` URL
  // under the jsdom environment these tests use.
  process.cwd(),
  "../shared/fixtures/redaction-fixture.json"
);

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  width: number;
  height: number;
  inputHex: string;
  cases: Array<{
    name: string;
    op: "pixelate" | "blur";
    size: number;
    rect: PixelRect;
    expectedHex: string;
  }>;
};

function fromHex(hex: string): Uint8ClampedArray {
  const out = new Uint8ClampedArray(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toHex(bytes: Uint8ClampedArray): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("redaction filters match the Rust export", () => {
  it("has a fixture with cases in it", () => {
    // Guards the reader itself: a path typo or an empty array would
    // otherwise make every case below pass by iterating nothing.
    expect(fixture.cases.length).toBeGreaterThan(0);
    expect(fixture.inputHex).toHaveLength(
      fixture.width * fixture.height * 4 * 2
    );
  });

  for (const testCase of fixture.cases) {
    it(`produces the same bytes as Rust for ${testCase.name}`, () => {
      const data = fromHex(fixture.inputHex);
      if (testCase.op === "pixelate") {
        pixelate(data, fixture.width, testCase.rect, testCase.size);
      } else {
        boxBlur(data, fixture.width, testCase.rect, testCase.size);
      }
      expect(toHex(data)).toBe(testCase.expectedHex);
    });
  }
});

describe("roundDiv", () => {
  it("rounds halves up, matching Rust's round_div", () => {
    // The single arithmetic decision the two implementations share.
    expect(roundDiv(0, 4)).toBe(0);
    expect(roundDiv(10, 4)).toBe(3);
    expect(roundDiv(9, 2)).toBe(5);
    expect(roundDiv(7, 2)).toBe(4);
  });

  it("treats an empty mean as zero rather than dividing by it", () => {
    expect(roundDiv(5, 0)).toBe(0);
  });
});

describe("normToPixels", () => {
  it("resolves a full rect to the whole frame", () => {
    expect(normToPixels({ x: 0, y: 0, w: 1, h: 1 }, 100, 50)).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 50,
    });
  });

  it("keeps the on-frame part of a rect that hangs off the edge", () => {
    const rect = normToPixels({ x: 0.5, y: 0, w: 5, h: 1 }, 100, 20);
    expect(rect).not.toBeNull();
    expect(rect!.x).toBe(50);
    expect(rect!.x + rect!.w).toBe(100);
  });

  it("resolves a rect covering no pixels to null", () => {
    // A half-finished drag is nothing to do, not an error.
    expect(normToPixels({ x: 0, y: 0, w: 0, h: 1 }, 100, 100)).toBeNull();
    expect(normToPixels({ x: 0, y: 0, w: 1, h: 0 }, 100, 100)).toBeNull();
    expect(normToPixels({ x: 2, y: 0, w: 1, h: 1 }, 100, 100)).toBeNull();
    expect(
      normToPixels({ x: Number.NaN, y: 0, w: 1, h: 1 }, 100, 100)
    ).toBeNull();
    expect(normToPixels({ x: 0, y: 0, w: 1, h: 1 }, 0, 10)).toBeNull();
  });
});

describe("pixelate", () => {
  it("raises a block too small to redact up to the floor", () => {
    // A block of 1 is the identity — a redaction that redacts nothing.
    const data = new Uint8ClampedArray(3 * 3 * 4);
    data.fill(0);
    data[0] = 255;
    data[1] = 255;
    data[2] = 255;
    pixelate(data, 3, { x: 0, y: 0, w: 3, h: 3 }, 1);
    expect(data[0]).not.toBe(255);
    expect(MIN_PIXELATE_BLOCK).toBeGreaterThan(2);
  });

  it("leaves alpha alone", () => {
    // A redaction that changed transparency would be a hole rather than
    // a cover-up.
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(128);
    pixelate(data, 4, { x: 0, y: 0, w: 4, h: 4 }, 4);
    expect(data[3]).toBe(128);
  });
});

describe("boxBlur", () => {
  it("leaves a flat region unchanged", () => {
    // The mean of identical values is that value, so any drift here is
    // a bug in the windowing rather than in the arithmetic.
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 77;
      data[i + 1] = 88;
      data[i + 2] = 99;
      data[i + 3] = 255;
    }
    const before = toHex(data);
    boxBlur(data, 16, { x: 0, y: 0, w: 16, h: 16 }, 3);
    expect(toHex(data)).toBe(before);
  });

  it("is a no-op at zero radius", () => {
    const data = new Uint8ClampedArray(4 * 4 * 4).fill(30);
    const before = toHex(data);
    boxBlur(data, 4, { x: 0, y: 0, w: 4, h: 4 }, 0);
    expect(toHex(data)).toBe(before);
  });

  it("reads no pixel from outside its rect", () => {
    // Otherwise the redaction leaks both ways: a blurred trace of what
    // it hides bleeds outward, and the surroundings bleed in.
    const size = 12;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    for (let y = 4; y < 8; y += 1) {
      for (let x = 4; x < 8; x += 1) {
        const i = (y * size + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
    boxBlur(data, size, { x: 4, y: 4, w: 4, h: 4 }, 2);
    for (let y = 4; y < 8; y += 1) {
      for (let x = 4; x < 8; x += 1) {
        expect(data[(y * size + x) * 4]).toBe(0);
      }
    }
  });
});

describe("applyRedactions", () => {
  const pixelateAt = (startMs: number, endMs: number): Annotation => ({
    id: "a",
    kind: "pixelate",
    rect: { x: 0, y: 0, w: 1, h: 1 },
    block: 8,
    startMs,
    endMs,
  });

  it("applies only the annotations covering the moment", () => {
    const data = new Uint8ClampedArray(8 * 8 * 4).fill(255);
    data[0] = 0;
    const annotations = [pixelateAt(5_000, 6_000)];

    applyRedactions(data, 8, 8, annotations, 1_000);
    expect(data[0]).toBe(0);

    applyRedactions(data, 8, 8, annotations, 5_500);
    expect(data[0]).not.toBe(0);
  });

  it("ignores drawn annotations, which travel as overlays instead", () => {
    // The split has to be decided in one place or the preview and the
    // export disagree about what a given annotation even is.
    const data = new Uint8ClampedArray(8 * 8 * 4).fill(255);
    data[0] = 0;
    applyRedactions(
      data,
      8,
      8,
      [
        {
          id: "b",
          kind: "box",
          rect: { x: 0, y: 0, w: 1, h: 1 },
          color: "#f00",
          filled: true,
          strokeWidth: 2,
          startMs: 0,
          endMs: 10_000,
        },
      ],
      1_000
    );
    expect(data[0]).toBe(0);
  });
});
