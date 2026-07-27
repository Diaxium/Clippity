import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeEllipse,
  makeImage,
  type ChromeSpec,
  type SceneNode,
} from "../types";
import {
  CHROME_PRESETS,
  DEFAULT_CHROME_HEIGHT,
  MAX_CHROME_HEIGHT,
  MIN_CHROME_HEIGHT,
  canCarryChrome,
  chromeBarRect,
  chromeControls,
  chromeDots,
  chromeHeight,
  chromeInk,
  chromeOf,
  chromePreset,
  chromeSeparator,
  chromeTitle,
  chromeWindowRadii,
  chromeWindowRect,
  clampChromeHeight,
  makeChrome,
  matchChromePreset,
} from "./chrome";

const BOX = { x: 0, y: 0, width: 800, height: 500 };

function macos(over: Partial<ChromeSpec> = {}): ChromeSpec {
  return {
    style: "macos",
    height: DEFAULT_CHROME_HEIGHT,
    color: "#e8e6e6",
    title: "",
    ...over,
  };
}

/** The capture as `sceneFromImage` seeds it, optionally chromed. */
function capture(chrome: ChromeSpec | null = null, radius = 0): SceneNode {
  __resetNodeIdForTests();
  const node = makeImage(BOX, "data:image/png;base64,AA", { name: "Photo" });
  node.cornerRadius = radius;
  node.chrome = chrome;
  return node;
}

describe("chromeWindowRect", () => {
  it("is the node's own rect with no chrome, so callers need no null check", () => {
    expect(chromeWindowRect(capture())).toEqual(BOX);
  });

  it("grows upward by the bar, leaving the capture's own box untouched", () => {
    // The load-bearing choice: the bar sits *above* the capture rather than
    // over it, so no pixels are covered and chrome stays non-destructive.
    const node = capture(macos({ height: 40 }));
    expect(chromeWindowRect(node)).toEqual({
      x: 0,
      y: -40,
      width: 800,
      height: 540,
    });
    expect(chromeBarRect(node)).toEqual({
      x: 0,
      y: -40,
      width: 800,
      height: 40,
    });
  });

  it("ignores chrome on a node neither renderer can draw it on", () => {
    // "The capture" is whatever holds the largest image fill, and an ellipse
    // could qualify — but there is no title-bar code path for one, so a stale
    // spec has to be inert rather than half-rendered.
    __resetNodeIdForTests();
    const ellipse = makeEllipse(BOX);
    ellipse.chrome = macos();
    expect(canCarryChrome(ellipse)).toBe(false);
    expect(chromeOf(ellipse)).toBeNull();
    expect(chromeHeight(ellipse)).toBe(0);
    expect(chromeBarRect(ellipse)).toBeNull();
    expect(chromeWindowRect(ellipse)).toEqual(BOX);
  });
});

describe("chromeWindowRadii", () => {
  it("puts the capture's corners on the window — top on the bar, bottom on the image", () => {
    const radii = chromeWindowRadii(capture(macos(), 12));
    expect(radii).toEqual({ tl: 12, tr: 12, br: 12, bl: 12 });
  });

  it("stays clamped by the capture, which the taller window always admits", () => {
    // `cornerRadiiOf` bounds by the shorter side; the window is only ever
    // taller, so a radius that fits the capture cannot overflow the window.
    const radii = chromeWindowRadii(capture(macos(), 9999));
    expect(radii.tl).toBe(BOX.height / 2);
  });
});

describe("chrome height", () => {
  it("clamps out-of-range heights", () => {
    expect(clampChromeHeight(0)).toBe(MIN_CHROME_HEIGHT);
    expect(clampChromeHeight(1e9)).toBe(MAX_CHROME_HEIGHT);
    expect(clampChromeHeight(NaN)).toBe(DEFAULT_CHROME_HEIGHT);
    expect(clampChromeHeight(41.6)).toBe(42);
  });

  it("clamps when reading too, so a hand-edited sidecar can't blow up the page", () => {
    expect(chromeHeight(capture(macos({ height: 1e9 })))).toBe(
      MAX_CHROME_HEIGHT
    );
  });
});

describe("chromeDots (macOS traffic lights)", () => {
  it("places three dots along the left of the bar", () => {
    const dots = chromeDots(capture(macos()));
    expect(dots).toHaveLength(3);
    expect(dots.map((d) => d.color)).toEqual(["#ff5f57", "#febc2e", "#28c840"]);
    // All on the bar's vertical centre, evenly spaced.
    const cy = -DEFAULT_CHROME_HEIGHT / 2;
    expect(dots.every((d) => d.cy === cy)).toBe(true);
    expect(dots[1]!.cx - dots[0]!.cx).toBe(dots[2]!.cx - dots[1]!.cx);
  });

  it("scales with the bar height rather than pinning a pixel size", () => {
    // A 2x bar should be the same design at twice the size, not a normal bar
    // with lost dots in the corner.
    const one = chromeDots(capture(macos({ height: 36 })));
    const two = chromeDots(capture(macos({ height: 72 })));
    expect(two[0]!.r).toBeCloseTo(one[0]!.r * 2);
    expect(two[0]!.cx - BOX.x).toBeCloseTo((one[0]!.cx - BOX.x) * 2);
  });

  it("drops the dots on a capture too narrow to hold them", () => {
    const narrow = capture(macos());
    narrow.width = 24;
    expect(chromeDots(narrow)).toEqual([]);
  });

  it("draws none for the Windows style", () => {
    expect(chromeDots(capture(macos({ style: "windows" })))).toEqual([]);
  });
});

describe("chromeControls (Windows caption buttons)", () => {
  it("emits minimize, maximize and close as strokable polylines", () => {
    const controls = chromeControls(
      capture(macos({ style: "windows", color: "#f3f3f3" }))
    );
    expect(controls).toHaveLength(3);
    // Minimize is one line, maximize a closed box, close two crossing strokes.
    expect(controls[0]!.strokes).toHaveLength(1);
    expect(controls[0]!.strokes[0]).toHaveLength(2);
    expect(controls[1]!.strokes[0]).toHaveLength(5);
    expect(controls[2]!.strokes).toHaveLength(2);
  });

  it("keeps them inside the bar, right-aligned in slot order", () => {
    const node = capture(macos({ style: "windows" }));
    const bar = chromeBarRect(node)!;
    const controls = chromeControls(node);
    const xs = controls.flatMap((c) => c.strokes.flat().map((p) => p.x));
    const ys = controls.flatMap((c) => c.strokes.flat().map((p) => p.y));
    expect(Math.min(...xs)).toBeGreaterThan(bar.x + bar.width / 2);
    expect(Math.max(...xs)).toBeLessThanOrEqual(bar.x + bar.width);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(bar.y);
    expect(Math.max(...ys)).toBeLessThanOrEqual(bar.y + bar.height);
  });

  it("drops them rather than colliding with the title on a narrow capture", () => {
    const narrow = capture(macos({ style: "windows" }));
    narrow.width = 80;
    expect(chromeControls(narrow)).toEqual([]);
  });

  it("draws none for the macOS style", () => {
    expect(chromeControls(capture(macos()))).toEqual([]);
  });
});

describe("chromeTitle", () => {
  it("is null when there is no text to draw", () => {
    expect(chromeTitle(capture(macos({ title: "" })))).toBeNull();
    expect(chromeTitle(capture(macos({ title: "   " })))).toBeNull();
  });

  it("centres on macOS and left-aligns on Windows — each desktop's convention", () => {
    const mac = chromeTitle(capture(macos({ title: "Report" })))!;
    expect(mac.align).toBe("center");
    expect(mac.x).toBe(BOX.width / 2);

    const win = chromeTitle(
      capture(macos({ style: "windows", title: "Report" }))
    )!;
    expect(win.align).toBe("left");
    expect(win.x).toBeLessThan(BOX.width / 2);
  });

  it("sits on the bar's vertical centre", () => {
    const title = chromeTitle(capture(macos({ height: 48, title: "x" })))!;
    expect(title.y).toBe(-24);
  });
});

describe("chromeInk", () => {
  it("picks near-black on light bars and near-white on dark ones", () => {
    expect(chromeInk("#ffffff")).toBe("#1c1d20");
    expect(chromeInk("#f3f3f3")).toBe("#1c1d20");
    expect(chromeInk("#000000")).toBe("#eceef0");
    expect(chromeInk("#2b2b2b")).toBe("#eceef0");
  });

  it("weights channels by luminance, not by whichever is largest", () => {
    // Saturated blue is dark despite a full channel; saturated green is light.
    expect(chromeInk("#0000ff")).toBe("#eceef0");
    expect(chromeInk("#00ff00")).toBe("#1c1d20");
  });

  it("accepts shorthand hex", () => {
    expect(chromeInk("#fff")).toBe("#1c1d20");
  });
});

describe("chromeSeparator", () => {
  it("runs along the seam between the bar and the capture", () => {
    const line = chromeSeparator(capture(macos({ height: 30 })))!;
    expect(line.y).toBe(BOX.y);
    expect(line.x1).toBe(BOX.x);
    expect(line.x2).toBe(BOX.x + BOX.width);
  });

  it("is null with no chrome", () => {
    expect(chromeSeparator(capture())).toBeNull();
  });
});

describe("presets", () => {
  it("offers a None entry so the chips are a round trip, not a one-way door", () => {
    expect(CHROME_PRESETS[0]!.id).toBe("none");
    expect(makeChrome(CHROME_PRESETS[0]!)).toBeNull();
  });

  it("round-trips every preset through the matcher", () => {
    for (const preset of CHROME_PRESETS) {
      expect(matchChromePreset(makeChrome(preset))).toBe(preset.id);
    }
  });

  it("carries the title across a style switch — it's content, not style", () => {
    const win = makeChrome(chromePreset("windows")!, "Dashboard")!;
    expect(win.style).toBe("windows");
    expect(win.title).toBe("Dashboard");
  });

  it("reports an edited bar as no preset rather than keeping a stale chip", () => {
    // Matching on the painted result (style + color) is what lets the panel be
    // honest once a future control recolors the bar.
    const edited = makeChrome(chromePreset("macos")!)!;
    expect(matchChromePreset({ ...edited, color: "#123456" })).toBe("");
    // Height is not part of the identity: a taller macOS bar is still macOS.
    expect(matchChromePreset({ ...edited, height: 64 })).toBe("macos");
  });

  it("reports None for an absent spec", () => {
    expect(matchChromePreset(null)).toBe("none");
    expect(matchChromePreset(undefined)).toBe("none");
  });
});
