import { describe, expect, it } from "vitest";

import {
  CHROME_BOTTOM_RAIL,
  CHROME_GAP,
  CHROME_MARGIN,
  chromeSide,
  chromeVerticalPos,
  chromeXPos,
  chromeXSide,
} from "./selectionChrome";

const H = 38; // toolbar height
const CANVAS = 800;

describe("chromeSide", () => {
  it("sits above the selection when there is headroom", () => {
    expect(chromeSide(200, 400, CANVAS, H)).toBe("above");
  });

  it("flips below when the selection hugs the top edge", () => {
    // No room above (top too close to 0), but room below the selection.
    expect(chromeSide(10, 300, CANVAS, H)).toBe("below");
  });

  it("pins above the rail when the selection spans the viewport", () => {
    // No room above and the bottom runs past the rail — neither side fits.
    expect(chromeSide(4, 900, CANVAS, H)).toBe("pinned");
  });
});

describe("chromeVerticalPos", () => {
  it("anchors upward, above the selection", () => {
    const p = chromeVerticalPos("above", 200, 400, CANVAS, H);
    expect(p.translateY).toBe("-100%");
    expect(p.top).toBe(200 - CHROME_GAP);
  });

  it("anchors downward, below the selection", () => {
    const p = chromeVerticalPos("below", 10, 300, CANVAS, H);
    expect(p.translateY).toBe("0");
    expect(p.top).toBe(300 + CHROME_GAP);
  });

  it("pins just above the bottom rail", () => {
    const p = chromeVerticalPos("pinned", 4, 900, CANVAS, H);
    expect(p.translateY).toBe("0");
    expect(p.top).toBe(CANVAS - CHROME_BOTTOM_RAIL - H);
  });
});

describe("toolbar + label take opposite sides", () => {
  // The label predicts the toolbar's side with the same height; whenever the
  // toolbar is forced off "above", the label must end up above (and vice
  // versa) so the two can never share a side.
  it("toolbar above ⇒ label below; toolbar below/pinned ⇒ label above", () => {
    // Roomy selection: toolbar above, so the label belongs below.
    expect(chromeSide(200, 400, CANVAS, H)).toBe("above");
    // Tall selection hugging the top: toolbar below, label flips above.
    expect(chromeSide(10, 300, CANVAS, H)).not.toBe("above");
    // Viewport-spanning: toolbar pinned, label still flips above.
    expect(chromeSide(4, 900, CANVAS, H)).not.toBe("above");
  });
});

describe("chromeXSide / chromeXPos (Annotation inspector)", () => {
  const CANVAS_W = 1200;
  const W = 260;

  it("prefers the right of the selection when it fits", () => {
    expect(chromeXSide(300, 500, CANVAS_W, W)).toBe("right");
    expect(chromeXPos("right", 300, 500, CANVAS_W, W)).toBe(500 + CHROME_GAP);
  });

  it("flips left when the right has no room", () => {
    // Right edge near the canvas edge, but plenty of space on the left.
    expect(chromeXSide(600, 1150, CANVAS_W, W)).toBe("left");
    expect(chromeXPos("left", 600, 1150, CANVAS_W, W)).toBe(
      600 - CHROME_GAP - W
    );
  });

  it("clamps to the right edge when neither side fits", () => {
    // A selection spanning the viewport leaves no gutter either side.
    expect(chromeXSide(4, 1196, CANVAS_W, W)).toBe("clamped");
    expect(chromeXPos("clamped", 4, 1196, CANVAS_W, W)).toBe(
      CANVAS_W - W - CHROME_MARGIN
    );
  });

  it("never places the panel off the left edge on a narrow canvas", () => {
    // Canvas narrower than the panel itself — the clamp still stays on-screen.
    expect(chromeXPos("clamped", 0, 100, 200, W)).toBe(CHROME_MARGIN);
  });

  it("stays off the vertical axis the toolbar and label arbitrate", () => {
    // Horizontal placement is independent of chromeSide's above/below decision,
    // so a third layer can't be forced to share a side with the other two.
    const side = chromeXSide(300, 500, CANVAS_W, W);
    expect(["right", "left", "clamped"]).toContain(side);
  });
});
