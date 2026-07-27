import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeEllipse,
  makeFrame,
  makeGradientPaint,
  makeImage,
  makeImagePaint,
  makeLine,
  makePath,
  makePolygon,
  makeRectangle,
  makeShadow,
  makeSolidPaint,
  makeStroke,
  type Effect,
  type LineNode,
  type MeasureSpec,
  type RectangleNode,
  type SceneNode,
  type StampKind,
} from "../types";
import { makeSpotlight } from "../lib/spotlight";
import { stampGeometry } from "../lib/stamps";
import { SceneNodeView } from "./SceneNodeView";

function rectWith(effects: Effect[]): RectangleNode {
  __resetNodeIdForTests();
  const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
  r.effects = effects;
  return r;
}

/** Lower-cased serialized contents of the node's `<filter>`, or "" if none.
 *  (Avoids jsdom SVG tag-name case quirks in selectors.) */
function filterHtml(container: HTMLElement): string {
  return (container.querySelector("filter")?.innerHTML ?? "").toLowerCase();
}

afterEach(cleanup);

describe("SceneNodeView effects filter", () => {
  it("emits no filter when the node has no visible effects", () => {
    const r = rectWith([]);
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{}} />
      </svg>
    );
    expect(container.querySelector("filter")).toBeNull();
  });

  it("emits feMorphology(dilate) for a drop shadow with positive spread", () => {
    const r = rectWith([{ ...makeShadow(), type: "drop-shadow", spread: 6 }]);
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{}} />
      </svg>
    );
    const html = filterHtml(container);
    expect(html).toContain("femorphology");
    expect(html).toContain('operator="dilate"');
  });

  it("omits feMorphology when spread is zero", () => {
    const r = rectWith([{ ...makeShadow(), type: "drop-shadow", spread: 0 }]);
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{}} />
      </svg>
    );
    const html = filterHtml(container);
    expect(html).not.toContain("femorphology");
    expect(html).toContain("feflood");
  });

  it("emits the inner-shadow composite recipe", () => {
    const r = rectWith([{ ...makeShadow(), type: "inner-shadow" }]);
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{}} />
      </svg>
    );
    const html = filterHtml(container);
    expect(html).toContain('operator="out"');
    expect(html).toContain("feflood");
  });
});

describe("SceneNodeView sample regions", () => {
  it("blur region samples the base image with a gaussian blur", () => {
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,BG"
    );
    const blur = makeRectangle({ x: 10, y: 10, width: 30, height: 30 });
    blur.fills = [];
    blur.sample = { mode: "blur", amount: 8 };
    const { container } = render(
      <svg>
        <SceneNodeView node={blur} nodes={{ [img.id]: img, [blur.id]: blur }} />
      </svg>
    );
    expect(container.querySelector("image")).not.toBeNull();
    expect(container.innerHTML.toLowerCase()).toContain("fegaussianblur");
  });

  it("magnifier region scales the base image about its center", () => {
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,BG"
    );
    const mag = makeEllipse({ x: 20, y: 20, width: 40, height: 40 });
    mag.fills = [];
    mag.sample = { mode: "magnify", amount: 2 };
    const { container } = render(
      <svg>
        <SceneNodeView node={mag} nodes={{ [img.id]: img, [mag.id]: mag }} />
      </svg>
    );
    const image = container.querySelector("image");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("transform")).toContain("scale(2)");
  });

  it("pixelate region shows a privacy placeholder until the mosaic is ready", () => {
    // jsdom never fires the image decode, so the async mosaic never resolves —
    // the region must paint the neutral block, never the original pixels.
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,BG"
    );
    const pix = makeRectangle({ x: 10, y: 10, width: 30, height: 30 });
    pix.fills = [];
    pix.sample = { mode: "pixelate", amount: 12 };
    const { container } = render(
      <svg>
        <SceneNodeView node={pix} nodes={{ [img.id]: img, [pix.id]: pix }} />
      </svg>
    );
    expect(container.querySelector('rect[fill="#8b8f96"]')).not.toBeNull();
    expect(container.querySelector("image")).toBeNull();
  });

  it("renders no sampled image when the scene has none", () => {
    __resetNodeIdForTests();
    const blur = makeRectangle({ x: 10, y: 10, width: 30, height: 30 });
    blur.fills = [];
    blur.sample = { mode: "blur", amount: 8 };
    const { container } = render(
      <svg>
        <SceneNodeView node={blur} nodes={{ [blur.id]: blur }} />
      </svg>
    );
    expect(container.querySelector("image")).toBeNull();
  });

  it("clips the magnifier on an untransformed group, not the scaled image", () => {
    // Regression: clip-path on the scaled <image> scales with it, so the loupe
    // bled past its shape by the zoom factor. The clip must sit on an ancestor
    // group that is NOT scaled (matching the Canvas2D export). See ADR 0015.
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,BG"
    );
    const mag = makeEllipse({ x: 20, y: 20, width: 40, height: 40 });
    mag.fills = [];
    mag.sample = { mode: "magnify", amount: 2 };
    const { container } = render(
      <svg>
        <SceneNodeView node={mag} nodes={{ [img.id]: img, [mag.id]: mag }} />
      </svg>
    );
    const image = container.querySelector("image")!;
    expect(image.getAttribute("transform")).toContain("scale(2)");
    // The transformed image carries no clip of its own…
    expect(image.getAttribute("clip-path")).toBeNull();
    // …its parent group carries the clip and is not scaled.
    const group = image.parentElement!;
    expect(group.tagName.toLowerCase()).toBe("g");
    expect(group.getAttribute("clip-path")).toMatch(/^url\(#/);
    expect(group.getAttribute("transform")).toBeNull();
  });

  it("applies a sample to a polygon, clipped to the polygon", () => {
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,BG"
    );
    const poly = makePolygon(
      { x: 10, y: 10, width: 40, height: 40 },
      { sides: 5 }
    );
    poly.fills = [];
    poly.sample = { mode: "blur", amount: 8 };
    const { container } = render(
      <svg>
        <SceneNodeView node={poly} nodes={{ [img.id]: img, [poly.id]: poly }} />
      </svg>
    );
    const image = container.querySelector("image");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("clip-path")).toMatch(/^url\(#/);
    expect(container.innerHTML.toLowerCase()).toContain("fegaussianblur");
  });

  it("applies a sample to a pen/pencil path, clipped to the path", () => {
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,BG"
    );
    const path = makePath(
      [
        { x: 10, y: 10 },
        { x: 50, y: 10 },
        { x: 30, y: 50 },
      ],
      true
    );
    path.fills = [];
    path.sample = { mode: "blur", amount: 8 };
    const { container } = render(
      <svg>
        <SceneNodeView node={path} nodes={{ [img.id]: img, [path.id]: path }} />
      </svg>
    );
    const image = container.querySelector("image");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("clip-path")).toMatch(/^url\(#/);
    expect(container.innerHTML.toLowerCase()).toContain("fegaussianblur");
  });

  it("paints the sample behind the fill so a translucent fill still shows", () => {
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,BG"
    );
    const r = makeRectangle({ x: 10, y: 10, width: 30, height: 30 });
    // Frosted glass: a blur sample under a translucent fill.
    r.sample = { mode: "blur", amount: 8 };
    r.fills = [{ ...r.fills[0]!, color: "#9747ff", opacity: 0.4 }];
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{ [img.id]: img, [r.id]: r }} />
      </svg>
    );
    // The sampled image renders…
    expect(container.querySelector("image")).not.toBeNull();
    // …and so does the fill on top of it (a path with a real fill, not "none").
    const fillPath = Array.from(container.querySelectorAll("path")).find(
      (p) => {
        const f = p.getAttribute("fill");
        return f !== null && f !== "none";
      }
    );
    expect(fillPath).toBeTruthy();
  });

  it("hides a disabled sample, falling through to the original beneath", () => {
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 100, height: 100 },
      "data:image/png;base64,BG"
    );
    const blur = makeRectangle({ x: 10, y: 10, width: 30, height: 30 });
    blur.fills = [];
    blur.sample = { mode: "blur", amount: 8, enabled: false };
    const { container } = render(
      <svg>
        <SceneNodeView node={blur} nodes={{ [img.id]: img, [blur.id]: blur }} />
      </svg>
    );
    // No sampled image and no blur filter — the region reveals the capture.
    expect(container.querySelector("image")).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain("fegaussianblur");
  });
});

describe("SceneNodeView blend mode", () => {
  it("applies a node blend mode to the group (Highlighter)", () => {
    __resetNodeIdForTests();
    const h = makeRectangle({ x: 0, y: 0, width: 30, height: 20 });
    h.blendMode = "multiply";
    const { container } = render(
      <svg>
        <SceneNodeView node={h} nodes={{ [h.id]: h }} />
      </svg>
    );
    expect(container.querySelector("g")?.style.mixBlendMode).toBe("multiply");
  });

  it("wraps a per-fill blend mode in its own mix-blend-mode group", () => {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 30, height: 20 });
    r.fills = [{ ...r.fills[0]!, blendMode: "screen" }];
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{ [r.id]: r }} />
      </svg>
    );
    const blended = Array.from(container.querySelectorAll("g")).find(
      (g) => g.style.mixBlendMode === "screen"
    );
    expect(blended).toBeTruthy();
    expect(blended!.querySelector("path")).not.toBeNull();
  });
});

describe("SceneNodeView step badge", () => {
  it("draws the number centered on the badge", () => {
    __resetNodeIdForTests();
    const badge = makeEllipse({ x: 0, y: 0, width: 40, height: 40 });
    badge.step = { number: 7 };
    const { container } = render(
      <svg>
        <SceneNodeView node={badge} nodes={{ [badge.id]: badge }} />
      </svg>
    );
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("7");
    expect(text?.getAttribute("text-anchor")).toBe("middle");
  });
});

describe("SceneNodeView image fill", () => {
  it("maps image scale/align to preserveAspectRatio", () => {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    const paint = makeImagePaint("data:image/png;base64,AAA");
    paint.imageScale = "fit";
    paint.imageAlign = "top-left";
    r.fills = [paint];
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{ [r.id]: r }} />
      </svg>
    );
    expect(
      container.querySelector("image")?.getAttribute("preserveAspectRatio")
    ).toBe("xMinYMin meet");
  });
});

describe("SceneNodeView gradient fills", () => {
  function radialRect(shape?: "circle" | "ellipse") {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 120, height: 60 });
    const paint = makeGradientPaint();
    paint.gradient!.kind = "radial";
    if (shape) paint.gradient!.shape = shape;
    r.fills = [paint];
    return r;
  }

  it("renders an ellipse radial via objectBoundingBox (fractional cx)", () => {
    const r = radialRect(); // default shape = ellipse
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{ [r.id]: r }} />
      </svg>
    );
    const rg = container.querySelector("radialGradient");
    expect(rg).not.toBeNull();
    expect(rg?.getAttribute("gradientUnits")).not.toBe("userSpaceOnUse");
    expect(rg?.getAttribute("cx")).toBe("0.5");
  });

  it("renders a true circle radial in user space (px)", () => {
    const r = radialRect("circle");
    const { container } = render(
      <svg>
        <SceneNodeView node={r} nodes={{ [r.id]: r }} />
      </svg>
    );
    const rg = container.querySelector("radialGradient");
    expect(rg?.getAttribute("gradientUnits")).toBe("userSpaceOnUse");
    // circle radius = 0.5 * box width (120) = 60px
    expect(rg?.getAttribute("r")).toBe("60");
  });
});

describe("SceneNodeView callout", () => {
  it("renders the bubble outline including the tail tip", () => {
    __resetNodeIdForTests();
    const c = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    c.callout = { angle: 180, length: 40 }; // tail aims down, tip at y=140
    const { container } = render(
      <svg>
        <SceneNodeView node={c} nodes={{ [c.id]: c }} />
      </svg>
    );
    const ds = Array.from(container.querySelectorAll("path")).map(
      (p) => p.getAttribute("d") ?? ""
    );
    expect(ds.some((d) => d.includes("140"))).toBe(true);
  });
});

describe("SceneNodeView window chrome", () => {
  /** A capture with a macOS bar, as `applyChrome` produces it. */
  function chromed(style: "macos" | "windows" = "macos") {
    __resetNodeIdForTests();
    const n = makeImage(
      { x: 0, y: 0, width: 800, height: 500 },
      "data:image/png;base64,AA"
    );
    n.cornerRadius = 10;
    n.chrome = {
      style,
      height: 36,
      color: style === "macos" ? "#e8e6e6" : "#f3f3f3",
      title: "Report",
    };
    return n;
  }

  it("takes its outline from the whole window, not the capture's box", () => {
    // The window outline is what makes the clip, the strokes and the lift
    // shadow treat bar + capture as one object instead of leaving a seam.
    const n = chromed();
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    const clip = container.querySelector("clipPath path")?.getAttribute("d");
    // Window top is 36px above the capture's y=0.
    expect(clip).toContain("-36");
  });

  it("draws the three macOS traffic lights", () => {
    const n = chromed("macos");
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    const fills = Array.from(container.querySelectorAll("circle")).map((c) =>
      c.getAttribute("fill")
    );
    expect(fills).toEqual(["#ff5f57", "#febc2e", "#28c840"]);
  });

  it("draws the Windows caption buttons as strokes, not glyph text", () => {
    // Strokes keep the SVG and the Canvas2D export on identical geometry; a
    // glyph font would have made them depend on matching text metrics.
    const n = chromed("windows");
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    expect(container.querySelectorAll("polyline").length).toBe(4);
    expect(container.querySelectorAll("circle").length).toBe(0);
  });

  it("renders the title inside the bar", () => {
    const n = chromed();
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    const text = Array.from(container.querySelectorAll("text")).find(
      (t) => t.textContent === "Report"
    );
    expect(text).toBeTruthy();
    expect(Number(text!.getAttribute("y"))).toBeLessThan(0);
  });

  it("draws nothing extra without a spec", () => {
    __resetNodeIdForTests();
    const n = makeImage(
      { x: 0, y: 0, width: 800, height: 500 },
      "data:image/png;base64,AA"
    );
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    expect(container.querySelectorAll("circle").length).toBe(0);
    expect(container.querySelectorAll("polyline").length).toBe(0);
  });
});

describe("SceneNodeView measurement", () => {
  /** A 600px horizontal dimension line with the default tick caps. */
  function dimension(spec: Partial<MeasureSpec> = {}): LineNode {
    __resetNodeIdForTests();
    const n = makeLine(
      { x: 100, y: 200, width: 600, height: 0 },
      { strokes: [makeStroke("#f24822", 2)] }
    );
    n.measure = { caps: "tick", scale: 1, unit: "px", ...spec };
    return n;
  }

  it("labels the line with its own length, in a pill on the midpoint", () => {
    const n = dimension();
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    const text = container.querySelector("text");
    expect(text?.textContent).toBe("600 px");
    // The pill rotates with the shaft about the midpoint — the SVG spelling of
    // the Canvas translate+rotate in `render.ts`'s `drawMeasure`.
    const rotated = Array.from(container.querySelectorAll("g")).find((g) =>
      (g.getAttribute("transform") ?? "").startsWith("rotate(")
    );
    expect(rotated?.getAttribute("transform")).toBe("rotate(0 400 200)");
    expect(rotated?.querySelector("rect")?.getAttribute("fill")).toBe(
      "#f24822"
    );
  });

  it("re-expresses the length through the spec's scale and unit", () => {
    const n = dimension({ scale: 0.5, unit: "pt" });
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    expect(container.querySelector("text")?.textContent).toBe("300 pt");
  });

  it("draws serif caps for ticks and filled heads for arrows", () => {
    const ticks = render(
      <svg>
        <SceneNodeView node={dimension()} nodes={{}} />
      </svg>
    );
    // Two shaft segments + two serifs, no arrowhead polygon.
    expect(ticks.container.querySelectorAll("line")).toHaveLength(4);
    expect(ticks.container.querySelectorAll("polygon")).toHaveLength(0);
    cleanup();
    const arrows = render(
      <svg>
        <SceneNodeView node={dimension({ caps: "arrow" })} nodes={{}} />
      </svg>
    );
    expect(arrows.container.querySelectorAll("line")).toHaveLength(2);
    expect(arrows.container.querySelectorAll("polygon")).toHaveLength(2);
  });

  it("replaces the plain shaft rather than drawing over it", () => {
    // A plain line is one unbroken segment; a dimension's is broken around the
    // label, so a leftover full-width line would show through the pill's gap.
    const { container } = render(
      <svg>
        <SceneNodeView node={dimension()} nodes={{}} />
      </svg>
    );
    const spans = Array.from(container.querySelectorAll("line")).map((l) =>
      Math.abs(Number(l.getAttribute("x2")) - Number(l.getAttribute("x1")))
    );
    expect(spans.some((s) => s === 600)).toBe(false);
  });

  it("leaves a plain line alone without a spec", () => {
    __resetNodeIdForTests();
    const plain = makeLine(
      { x: 0, y: 0, width: 100, height: 0 },
      { strokes: [makeStroke("#f24822", 2)] }
    );
    const { container } = render(
      <svg>
        <SceneNodeView node={plain} nodes={{ [plain.id]: plain }} />
      </svg>
    );
    expect(container.querySelectorAll("line")).toHaveLength(1);
    expect(container.querySelector("text")).toBeNull();
  });
});

describe("SceneNodeView spotlight", () => {
  /** A sealed page (frame → image) with a spotlight rectangle child. */
  function spotScene(): {
    spot: RectangleNode;
    nodes: Record<string, SceneNode>;
  } {
    __resetNodeIdForTests();
    const frame = makeFrame(
      { x: 0, y: 0, width: 1000, height: 600 },
      { name: "Page", clipContent: true }
    );
    const photo = makeImage(
      { x: 0, y: 0, width: 1000, height: 600 },
      "data:image/png;base64,AA"
    );
    const spot = makeRectangle(
      { x: 100, y: 100, width: 200, height: 150 },
      { name: "Spotlight", fills: [], strokes: [] }
    );
    spot.spotlight = makeSpotlight();
    frame.children = [photo.id, spot.id];
    return {
      spot,
      nodes: { [frame.id]: frame, [photo.id]: photo, [spot.id]: spot },
    };
  }

  it("emits one even-odd scrim path covering the page with the region cut out", () => {
    const { spot, nodes } = spotScene();
    const { container } = render(
      <svg>
        <SceneNodeView node={spot} nodes={nodes} />
      </svg>
    );
    const scrim = Array.from(container.querySelectorAll("path")).find(
      (p) => p.getAttribute("fill-rule") === "evenodd"
    );
    expect(scrim).toBeTruthy();
    const d = scrim!.getAttribute("d") ?? "";
    expect(d.startsWith("M0,0 H1000 V600 H0 Z")).toBe(true); // dims the page…
    expect(d).toContain("M100,100"); // …and cuts out the region
    expect(Number(scrim!.getAttribute("fill-opacity"))).toBeCloseTo(0.6);
  });

  it("draws no scrim without a spec", () => {
    __resetNodeIdForTests();
    const plain = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    const { container } = render(
      <svg>
        <SceneNodeView node={plain} nodes={{ [plain.id]: plain }} />
      </svg>
    );
    expect(
      Array.from(container.querySelectorAll("path")).some(
        (p) => p.getAttribute("fill-rule") === "evenodd"
      )
    ).toBe(false);
  });
});

describe("SceneNodeView stamp", () => {
  /** A 48px stamp with red ink and a white halo — the tool's own seeds. */
  function stampNode(kind: StampKind = "check"): RectangleNode {
    __resetNodeIdForTests();
    const n = makeRectangle(
      { x: 100, y: 40, width: 48, height: 48 },
      {
        fills: [makeSolidPaint("#f24822", 1)],
        strokes: [makeStroke("#ffffff", 2)],
      }
    );
    n.stamp = { kind };
    return n;
  }

  it("paints the glyph from the shared paths instead of the rectangle", () => {
    const n = stampNode();
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    const geo = stampGeometry(n)!;
    const ds = Array.from(container.querySelectorAll("path")).map((p) =>
      p.getAttribute("d")
    );
    // Exactly the module's string — this and `render.ts`'s `drawStamp` fill the
    // same `d`, which is what makes the two renderers unable to drift.
    expect(ds).toContain(geo.strokeD);
    // …and no box outline left behind it (a check has no filled sub-path).
    expect(geo.fillD).toBe("");
    expect(ds).toHaveLength(2); // halo + ink, one path each
  });

  it("draws the halo under the ink, widened by the stroke on each side", () => {
    const n = stampNode();
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    const geo = stampGeometry(n)!;
    const paths = Array.from(container.querySelectorAll("path"));
    // Document order is paint order: halo first, ink over it.
    expect(paths[0]!.getAttribute("stroke")).toBe("rgba(255, 255, 255, 1)");
    expect(Number(paths[0]!.getAttribute("stroke-width"))).toBeCloseTo(
      geo.weight + 4
    );
    expect(paths[1]!.getAttribute("stroke")).toBe("rgba(242, 72, 34, 1)");
    expect(Number(paths[1]!.getAttribute("stroke-width"))).toBeCloseTo(
      geo.weight
    );
  });

  it("fills areal icons even-odd, so an icon's hole stays a hole", () => {
    const n = stampNode("pin");
    const { container } = render(
      <svg>
        <SceneNodeView node={n} nodes={{ [n.id]: n }} />
      </svg>
    );
    expect(
      Array.from(container.querySelectorAll("path")).every(
        (p) =>
          p.getAttribute("fill") === "none" ||
          p.getAttribute("fill-rule") === "evenodd"
      )
    ).toBe(true);
  });

  it("leaves a plain rectangle alone without a spec", () => {
    __resetNodeIdForTests();
    const plain = makeRectangle({ x: 0, y: 0, width: 48, height: 48 });
    const { container } = render(
      <svg>
        <SceneNodeView node={plain} nodes={{ [plain.id]: plain }} />
      </svg>
    );
    // The rect view draws its outline as one `cornerPath` — a closed box, not
    // the glyph's open polyline.
    const d = container.querySelector("path")?.getAttribute("d") ?? "";
    expect(d.endsWith("Z")).toBe(true);
  });
});
