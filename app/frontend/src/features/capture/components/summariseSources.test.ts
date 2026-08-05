import { describe, expect, it } from "vitest";

import { summariseSources } from "./RecordOptionsPanel";

/** The corner rects Settings' `CORNER_PRESETS` writes. */
const TOP_LEFT = { x: 0.03, y: 0.04 };
const BOTTOM_RIGHT = { x: 0.72, y: 0.71 };

describe("summariseSources", () => {
  it("says nothing is drawn when there are no sources", () => {
    expect(summariseSources([])).toBe("Nothing over the recording");
  });

  it("names the kind and the corner", () => {
    expect(summariseSources([{ kind: "webcam", rect: BOTTOM_RIGHT }])).toBe(
      "Camera bottom right"
    );
    expect(summariseSources([{ kind: "image", rect: TOP_LEFT }])).toBe(
      "Image top left"
    );
  });

  it("counts the rest rather than listing them", () => {
    // The row is one line in a two-column grid; a list would truncate
    // into something less useful than a count.
    expect(
      summariseSources([
        { kind: "webcam", rect: BOTTOM_RIGHT },
        { kind: "image", rect: TOP_LEFT },
        { kind: "image", rect: TOP_LEFT },
      ])
    ).toBe("Camera bottom right +2 more");
  });

  it("distinguishes configured-but-off from nothing configured", () => {
    // Otherwise a user who switched their sources off would see the
    // same text as one who never added any, and reach for Add.
    expect(
      summariseSources([
        { kind: "webcam", rect: BOTTOM_RIGHT, enabled: false },
        { kind: "image", rect: TOP_LEFT, enabled: false },
      ])
    ).toBe("2 configured · all off");
  });

  it("summarises the enabled ones, ignoring the disabled", () => {
    expect(
      summariseSources([
        { kind: "webcam", rect: BOTTOM_RIGHT, enabled: false },
        { kind: "image", rect: TOP_LEFT, enabled: true },
      ])
    ).toBe("Image top left");
  });

  it("describes a rect that matches no corner without guessing one", () => {
    // A preset from a future build, or a hand-edited settings file.
    expect(
      summariseSources([{ kind: "webcam", rect: { x: 0.4, y: 0.4 } }])
    ).toBe("Camera");
  });

  it("treats a missing enabled flag as on", () => {
    // `enabled` is serde-defaulted backend-side, so it can be absent on
    // the wire.
    expect(summariseSources([{ kind: "webcam", rect: TOP_LEFT }])).toBe(
      "Camera top left"
    );
  });
});
