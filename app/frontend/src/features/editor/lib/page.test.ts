import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeEllipse,
  makeFrame,
  makeImage,
  makeRectangle,
  makeSolidPaint,
  type FrameNode,
  type SceneDoc,
  type SceneNode,
} from "../types";
import {
  BACKDROP_PRESETS,
  DEFAULT_PAGE_PADDING,
  MAX_PAGE_PADDING,
  backdropPreset,
  clampPadding,
  hasContentShadow,
  makeContentShadow,
  matchBackdropPreset,
  pageContent,
  pagePadding,
  paddedPageRect,
  setContentRadius,
  setContentShadow,
  setPageBackdrop,
  setPagePadding,
  setWindowChrome,
} from "./page";

const BOX = { x: 0, y: 0, width: 400, height: 300 };

/** The shape `sceneFromImage` builds: one page frame with the capture inside. */
function scene(): SceneDoc & { pageId: string; photoId: string } {
  __resetNodeIdForTests();
  const frame = makeFrame(BOX, { name: "Page" });
  const photo = makeImage(BOX, "data:image/png;base64,AA", { name: "Photo" });
  frame.children = [photo.id];
  return {
    rootIds: [frame.id],
    nodes: { [frame.id]: frame, [photo.id]: photo },
    pageId: frame.id,
    photoId: photo.id,
  };
}

describe("pageContent", () => {
  it("resolves the capture node the page pads around", () => {
    const s = scene();
    const content = pageContent(s.nodes);
    expect(content?.id).toBe(s.photoId);
    expect(content?.rect).toEqual(BOX);
  });

  it("returns null on a document with no image", () => {
    __resetNodeIdForTests();
    const frame = makeFrame(BOX);
    expect(pageContent({ [frame.id]: frame })).toBeNull();
  });
});

describe("pagePadding", () => {
  it("is zero on a freshly-opened capture (page == capture)", () => {
    const s = scene();
    expect(pagePadding(s.nodes[s.pageId]!, BOX)).toBe(0);
  });

  it("measures the margin an outward crop already produced", () => {
    // Dragging a crop edge outward is the padding primitive (ADR 0019); this is
    // the read side of that same state.
    const s = scene();
    const page = { ...s.nodes[s.pageId]!, x: -20, y: -20 };
    page.width = 440;
    page.height = 340;
    expect(pagePadding(page, BOX)).toBe(20);
  });

  it("reports the smallest gap when the four sides disagree", () => {
    // What an asymmetric crop leaves behind: only the minimum is padding on
    // every side.
    const s = scene();
    const page = { ...s.nodes[s.pageId]!, x: -40, y: -10 };
    page.width = 500;
    page.height = 340;
    expect(pagePadding(page, BOX)).toBe(10);
  });

  it("floors at zero when the page is cropped inside the capture", () => {
    const s = scene();
    const page = { ...s.nodes[s.pageId]!, x: 50, y: 50 };
    page.width = 100;
    page.height = 100;
    expect(pagePadding(page, BOX)).toBe(0);
  });
});

describe("paddedPageRect", () => {
  it("surrounds the capture on all four sides", () => {
    expect(paddedPageRect(BOX, 32)).toEqual({
      x: -32,
      y: -32,
      width: 464,
      height: 364,
    });
  });

  it("rounds to whole pixels so the export lands on pixel edges", () => {
    const rect = paddedPageRect(
      { x: 0.4, y: 0.6, width: 100.5, height: 50.2 },
      10.4
    );
    expect(Object.values(rect).every(Number.isInteger)).toBe(true);
  });

  it("clamps out-of-range padding", () => {
    expect(clampPadding(-5)).toBe(0);
    expect(clampPadding(NaN)).toBe(0);
    expect(clampPadding(1e9)).toBe(MAX_PAGE_PADDING);
  });
});

describe("padding round-trips", () => {
  it("reads back exactly what was written", () => {
    const s = scene();
    for (const p of [0, 1, 24, DEFAULT_PAGE_PADDING, MAX_PAGE_PADDING]) {
      const next = setPagePadding(s, s.pageId, BOX, p);
      expect(pagePadding(next.nodes[s.pageId]!, BOX)).toBe(p);
    }
  });

  it("normalizes an asymmetric page to uniform padding on write", () => {
    // The convergence property: reading a lopsided page gives the min gap, and
    // writing it back makes all four sides agree.
    const s = scene();
    const lopsided: SceneDoc = {
      rootIds: s.rootIds,
      nodes: {
        ...s.nodes,
        [s.pageId]: {
          ...s.nodes[s.pageId]!,
          x: -40,
          y: -10,
          width: 500,
          height: 340,
        },
      },
    };
    const read = pagePadding(lopsided.nodes[s.pageId]!, BOX);
    const next = setPagePadding(lopsided, s.pageId, BOX, read);
    const page = next.nodes[s.pageId]!;
    expect(page.x).toBe(-10);
    expect(page.y).toBe(-10);
    expect(page.width).toBe(420);
    expect(page.height).toBe(320);
  });

  it("forces clipContent on, so the canvas shows the trim the export applies", () => {
    const s = scene();
    const unclipped: SceneDoc = {
      rootIds: s.rootIds,
      nodes: {
        ...s.nodes,
        [s.pageId]: {
          ...s.nodes[s.pageId]!,
          clipContent: false,
        } as SceneNode,
      },
    };
    const next = setPagePadding(unclipped, s.pageId, BOX, 20);
    const page = next.nodes[s.pageId]!;
    expect(page.type === "frame" && page.clipContent).toBe(true);
  });

  it("leaves the capture untouched — padding is non-destructive", () => {
    const s = scene();
    const next = setPagePadding(s, s.pageId, BOX, 64);
    expect(next.nodes[s.photoId]).toBe(s.nodes[s.photoId]);
  });
});

describe("sealing the page (the export-region trap)", () => {
  /** A document shaped like a real annotated capture: markup drawn past the
   *  image edge lives as a *sibling root* of the page, not inside it. */
  function withStray(): SceneDoc & {
    pageId: string;
    photoId: string;
    strayId: string;
  } {
    const s = scene();
    const stray = makeRectangle(
      { x: 600, y: 280, width: 200, height: 200 },
      { name: "Arrow past the edge" }
    );
    return {
      rootIds: [...s.rootIds, stray.id],
      nodes: { ...s.nodes, [stray.id]: stray },
      pageId: s.pageId,
      photoId: s.photoId,
      strayId: stray.id,
    };
  }

  it("padding folds strays in, so the page rect is the export region", () => {
    // Without this, `unionBounds` of the roots reaches past the padded page and
    // the backdrop — which is the page's *fill* — exports as an unpainted band
    // down the overhanging side. Crop hit the same trap (ADR 0019).
    const s = withStray();
    const next = setPagePadding(s, s.pageId, BOX, 48);
    expect(next.rootIds).toEqual([s.pageId]);
    const page = next.nodes[s.pageId]!;
    expect(page.type === "frame" && page.children).toContain(s.strayId);
  });

  it("a non-empty backdrop seals the page too", () => {
    const s = withStray();
    const next = setPageBackdrop(s, s.pageId, backdropPreset("violet")!.build());
    expect(next.rootIds).toEqual([s.pageId]);
  });

  it("clearing to None leaves the layer tree alone", () => {
    // Nothing to leave a gap, so restructuring would be a surprising side
    // effect of clearing a color.
    const s = withStray();
    const next = setPageBackdrop(s, s.pageId, []);
    expect(next.rootIds).toEqual(s.rootIds);
  });

  it("preserves paint order when folding strays in", () => {
    const s = withStray();
    const next = setPagePadding(s, s.pageId, BOX, 10);
    const page = next.nodes[s.pageId]!;
    // The page is the backmost root, so its children painted before the stray —
    // appending the stray after them reproduces the original sequence.
    expect(page.type === "frame" && page.children).toEqual([
      s.photoId,
      s.strayId,
    ]);
  });

  it("is idempotent once the page is already the sole root", () => {
    const s = withStray();
    const once = setPagePadding(s, s.pageId, BOX, 24);
    const twice = setPagePadding(once, s.pageId, BOX, 24);
    expect(twice.rootIds).toEqual([s.pageId]);
    expect(twice.nodes[s.pageId]).toEqual(once.nodes[s.pageId]);
  });
});

describe("backdrop presets", () => {
  it("every preset round-trips through matchBackdropPreset", () => {
    for (const preset of BACKDROP_PRESETS) {
      __resetNodeIdForTests();
      expect(matchBackdropPreset(preset.build())).toBe(preset.id);
    }
  });

  it("builds fresh paint ids each time so two applications can't collide", () => {
    __resetNodeIdForTests();
    const a = backdropPreset("violet")!.build();
    const b = backdropPreset("violet")!.build();
    expect(a[0]!.id).not.toBe(b[0]!.id);
    // …but they still match the same preset: identity is the painted result.
    expect(matchBackdropPreset(a)).toBe(matchBackdropPreset(b));
  });

  it("reports null once the backdrop is edited away from a preset", () => {
    __resetNodeIdForTests();
    const fills = backdropPreset("white")!.build();
    fills[0]!.color = "#ff0000";
    expect(matchBackdropPreset(fills)).toBeNull();
  });

  it("matches None on a transparent page", () => {
    expect(matchBackdropPreset([])).toBe("none");
  });

  it("paints the page frame, not the capture", () => {
    const s = scene();
    const next = setPageBackdrop(s, s.pageId, backdropPreset("slate")!.build());
    expect(next.nodes[s.pageId]!.fills).toHaveLength(1);
    expect(next.nodes[s.photoId]).toBe(s.nodes[s.photoId]);
  });

  it("ignores hidden fills when matching", () => {
    __resetNodeIdForTests();
    const fills = backdropPreset("white")!.build();
    const hidden = makeSolidPaint("#123456", 1);
    hidden.visible = false;
    expect(matchBackdropPreset([...fills, hidden])).toBe("white");
  });
});

describe("content treatment", () => {
  it("rounds the capture's corners and clears per-corner overrides", () => {
    const s = scene();
    const withCorners: SceneDoc = {
      rootIds: s.rootIds,
      nodes: {
        ...s.nodes,
        [s.photoId]: {
          ...s.nodes[s.photoId]!,
          cornerRadii: { tl: 40, tr: 0, br: 0, bl: 0 },
        } as SceneNode,
      },
    };
    const next = setContentRadius(withCorners, s.photoId, 12);
    const photo = next.nodes[s.photoId]!;
    expect(photo.type === "image" && photo.cornerRadius).toBe(12);
    expect(photo.type === "image" && photo.cornerRadii).toBeNull();
  });

  it("clamps the radius to half the shorter side", () => {
    const s = scene();
    const next = setContentRadius(s, s.photoId, 9999);
    const photo = next.nodes[s.photoId]!;
    // 300px tall capture → 150 is a perfect pill.
    expect(photo.type === "image" && photo.cornerRadius).toBe(150);
  });

  it("adds and removes the lift shadow", () => {
    const s = scene();
    const on = setContentShadow(s, s.photoId, true);
    expect(hasContentShadow(on.nodes[s.photoId]!)).toBe(true);
    const off = setContentShadow(on, s.photoId, false);
    expect(hasContentShadow(off.nodes[s.photoId]!)).toBe(false);
    expect(off.nodes[s.photoId]!.effects).toHaveLength(0);
  });

  it("is idempotent when the shadow is already on", () => {
    const s = scene();
    const on = setContentShadow(s, s.photoId, true);
    expect(setContentShadow(on, s.photoId, true)).toBe(on);
  });

  it("clears user-added drop shadows too, so the toggle can't desync", () => {
    const s = scene();
    const extra: SceneDoc = {
      rootIds: s.rootIds,
      nodes: {
        ...s.nodes,
        [s.photoId]: {
          ...s.nodes[s.photoId]!,
          effects: [makeContentShadow(), makeContentShadow()],
        },
      },
    };
    const off = setContentShadow(extra, s.photoId, false);
    expect(hasContentShadow(off.nodes[s.photoId]!)).toBe(false);
  });

  it("leaves non-shadow effects alone", () => {
    const s = scene();
    const blur = { ...makeContentShadow(), type: "layer-blur" as const };
    const withBlur: SceneDoc = {
      rootIds: s.rootIds,
      nodes: {
        ...s.nodes,
        [s.photoId]: { ...s.nodes[s.photoId]!, effects: [blur] },
      },
    };
    const off = setContentShadow(withBlur, s.photoId, false);
    expect(off.nodes[s.photoId]!.effects).toEqual([blur]);
    const on = setContentShadow(withBlur, s.photoId, true);
    expect(on.nodes[s.photoId]!.effects).toHaveLength(2);
  });
});

describe("setWindowChrome", () => {
  const BAR = 40;
  const spec = {
    style: "macos" as const,
    height: BAR,
    color: "#e8e6e6",
    title: "",
  };

  it("grows the page by exactly the bar, so the page can't clip it", () => {
    // The trap this transform exists for: the page frame clips its children, so
    // writing the spec alone would hide the bar behind the page's own top edge
    // on any document with less padding than the bar is tall.
    const s = scene();
    const next = setWindowChrome(s, s.pageId, s.photoId, spec);
    const page = next.nodes[s.pageId]!;
    expect(page.y).toBe(BOX.y - BAR);
    expect(page.height).toBe(BOX.height + BAR);
    // Sideways and below, nothing moved — the bar only grows upward.
    expect(page.x).toBe(BOX.x);
    expect(page.width).toBe(BOX.width);
  });

  it("preserves the existing margin on all four sides", () => {
    const s = scene();
    const padded = setPagePadding(s, s.pageId, BOX, 48);
    const next = setWindowChrome(padded, s.pageId, s.photoId, spec);
    const page = next.nodes[s.pageId]!;
    const content = pageContent(next.nodes)!;
    expect(pagePadding(page, content.rect)).toBe(48);
    // Still 48 around the *window*, which is now taller by the bar.
    expect(page.height).toBe(BOX.height + BAR + 96);
  });

  it("shrinks the page back when the chrome is cleared", () => {
    // Without the reverse path, removing chrome would leave an unexplained band
    // of backdrop above the capture.
    const s = scene();
    const on = setWindowChrome(s, s.pageId, s.photoId, spec);
    const off = setWindowChrome(on, s.pageId, s.photoId, null);
    const page = off.nodes[s.pageId]!;
    expect({
      x: page.x,
      y: page.y,
      width: page.width,
      height: page.height,
    }).toEqual(BOX);
    expect(off.nodes[s.photoId]!.chrome).toBeNull();
  });

  it("round-trips a margin across chrome on and back off", () => {
    const s = scene();
    const padded = setPagePadding(s, s.pageId, BOX, 24);
    const on = setWindowChrome(padded, s.pageId, s.photoId, spec);
    const off = setWindowChrome(on, s.pageId, s.photoId, null);
    expect(pagePadding(off.nodes[s.pageId]!, BOX)).toBe(24);
  });

  it("seals the page so the export region still matches the canvas", () => {
    // Inherited from `setPagePadding` — a stray annotation root outside the
    // grown page would otherwise stretch `unionBounds` past the backdrop
    // (ADR 0019/0020). Chrome reaches the same trap by growing the page.
    const s = scene();
    __resetNodeIdForTests();
    const stray = makeRectangle({ x: 900, y: 40, width: 60, height: 60 });
    const withStray: SceneDoc = {
      rootIds: [...s.rootIds, stray.id],
      nodes: { ...s.nodes, [stray.id]: stray },
    };
    const next = setWindowChrome(withStray, s.pageId, s.photoId, spec);
    expect(next.rootIds).toEqual([s.pageId]);
    expect((next.nodes[s.pageId] as FrameNode).children).toContain(stray.id);
  });

  it("measures against the window, so repeated writes converge", () => {
    // A second write must not stack a second bar's worth of margin on top of
    // the first — padding is read back from the already-chromed window.
    const s = scene();
    const once = setWindowChrome(s, s.pageId, s.photoId, spec);
    const twice = setWindowChrome(once, s.pageId, s.photoId, spec);
    expect(twice.nodes[s.pageId]).toEqual(once.nodes[s.pageId]);
  });

  it("grows the page again when the bar gets taller", () => {
    const s = scene();
    const short = setWindowChrome(s, s.pageId, s.photoId, spec);
    const tall = setWindowChrome(short, s.pageId, s.photoId, {
      ...spec,
      height: 80,
    });
    expect(tall.nodes[s.pageId]!.height).toBe(BOX.height + 80);
  });
});

describe("pageContent with chrome", () => {
  it("reports the window rect, which is what padding is measured against", () => {
    const s = scene();
    const next = setWindowChrome(s, s.pageId, s.photoId, {
      style: "windows",
      height: 32,
      color: "#f3f3f3",
      title: "",
    });
    const content = pageContent(next.nodes)!;
    expect(content.id).toBe(s.photoId);
    expect(content.rect).toEqual({
      x: 0,
      y: -32,
      width: 400,
      height: 332,
    });
  });
});

describe("degenerate documents", () => {
  it("every transform is inert on an unknown node id", () => {
    const s = scene();
    const doc: SceneDoc = { rootIds: s.rootIds, nodes: s.nodes };
    expect(setContentRadius(doc, "nope", 10)).toBe(doc);
    expect(setContentShadow(doc, "nope", true)).toBe(doc);
    expect(setPageBackdrop(doc, "nope", [])).toBe(doc);
    expect(setPagePadding(doc, "nope", BOX, 10)).toBe(doc);
    expect(setWindowChrome(doc, "nope", s.photoId, null)).toBe(doc);
    expect(setWindowChrome(doc, s.pageId, "nope", null)).toBe(doc);
  });

  it("finds an image-filled non-image node as the capture", () => {
    // `findBaseImage` keys on the fill, not the node type — the page model must
    // agree with the renderers about what the capture is.
    __resetNodeIdForTests();
    const frame = makeFrame(BOX, { name: "Page" });
    const blob = makeEllipse(BOX, { name: "Blob" });
    blob.fills = [{ ...makeSolidPaint("#000"), type: "image", src: "data:," }];
    frame.children = [blob.id];
    const content = pageContent({ [frame.id]: frame, [blob.id]: blob });
    expect(content?.id).toBe(blob.id);
  });
});
