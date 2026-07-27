import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  DEFAULT_SPOTLIGHT_COLOR,
  DEFAULT_SPOTLIGHT_OPACITY,
  makeEllipse,
  makeFrame,
  makeImage,
  makeRectangle,
  makeText,
  type SceneNode,
  type SpotlightSpec,
} from "../types";
import {
  SPOTLIGHT_TINTS,
  canCarrySpotlight,
  clampSpotlightOpacity,
  makeSpotlight,
  matchSpotlightTint,
  spotlightHoleD,
  spotlightOf,
  spotlightPageRect,
  spotlightScrim,
} from "./spotlight";

const PAGE = { x: 0, y: 0, width: 1000, height: 600 };

/** A sealed one-capture document: page frame → image child, plus any extra
 *  nodes as children of the page. */
function scene(extra: SceneNode[] = []): {
  nodes: Record<string, SceneNode>;
  pageId: string;
} {
  __resetNodeIdForTests();
  const frame = makeFrame(PAGE, { name: "Page", clipContent: true });
  const photo = makeImage(PAGE, "data:image/png;base64,AAAA", {
    name: "Photo",
  });
  frame.children = [photo.id, ...extra.map((n) => n.id)];
  const nodes: Record<string, SceneNode> = {
    [frame.id]: frame,
    [photo.id]: photo,
  };
  for (const n of extra) nodes[n.id] = n;
  return { nodes, pageId: frame.id };
}

function spot(over: Partial<SpotlightSpec> = {}) {
  const r = makeRectangle(
    { x: 100, y: 100, width: 200, height: 150 },
    {
      name: "Spotlight",
      fills: [],
      strokes: [],
    }
  );
  r.spotlight = { ...makeSpotlight(), ...over };
  return r;
}

describe("canCarrySpotlight", () => {
  it("accepts the two region shapes and rejects the rest", () => {
    expect(canCarrySpotlight(makeRectangle(PAGE))).toBe(true);
    expect(canCarrySpotlight(makeEllipse(PAGE))).toBe(true);
    expect(canCarrySpotlight(makeFrame(PAGE))).toBe(false);
    expect(canCarrySpotlight(makeImage(PAGE, "x"))).toBe(false);
    expect(canCarrySpotlight(makeText(PAGE))).toBe(false);
  });
});

describe("spotlightOf", () => {
  it("returns the spec on a capable node", () => {
    expect(spotlightOf(spot())).toEqual(makeSpotlight());
  });

  it("is null for a node with no spec", () => {
    expect(spotlightOf(makeRectangle(PAGE))).toBeNull();
  });

  it("ignores a stale spec on a non-region node (inert, not half-rendered)", () => {
    const img = makeImage(PAGE, "x");
    (img as SceneNode).spotlight = makeSpotlight();
    expect(spotlightOf(img)).toBeNull();
  });
});

describe("spotlightPageRect", () => {
  it("is the page frame's rect — the outermost frame ancestor of the capture", () => {
    const { nodes } = scene();
    expect(spotlightPageRect(nodes)).toEqual(PAGE);
  });

  it("falls back to the capture's own rect when it has no frame ancestor", () => {
    __resetNodeIdForTests();
    const photo = makeImage(
      { x: 5, y: 7, width: 300, height: 200 },
      "data:image/png;base64,AAAA"
    );
    expect(spotlightPageRect({ [photo.id]: photo })).toEqual({
      x: 5,
      y: 7,
      width: 300,
      height: 200,
    });
  });

  it("is null on a document with no capture", () => {
    expect(spotlightPageRect({})).toBeNull();
  });
});

describe("spotlightHoleD", () => {
  it("traces a rectangle's rounded outline", () => {
    const r = makeRectangle({ x: 10, y: 20, width: 100, height: 80 });
    r.cornerRadius = 8;
    const d = spotlightHoleD(r);
    expect(d.startsWith("M")).toBe(true);
    // A rounded rect uses arc segments.
    expect(d).toContain("A8,8");
  });

  it("traces an ellipse as two half-arcs", () => {
    const e = makeEllipse({ x: 0, y: 0, width: 200, height: 100 });
    const d = spotlightHoleD(e);
    // center (100,50), radii (100,50): two A100,50 sweeps.
    expect(d).toContain("A100,50");
    expect(d.match(/A/g)?.length).toBe(2);
  });
});

describe("spotlightScrim", () => {
  it("is null without a spec or a page to dim", () => {
    const { nodes } = scene();
    expect(spotlightScrim(makeRectangle(PAGE), nodes)).toBeNull();
    expect(spotlightScrim(spot(), {})).toBeNull(); // no capture → no page
  });

  it("concatenates the page rect and the region hole for an even-odd fill", () => {
    const s = spot();
    const { nodes } = scene([s]);
    const scrim = spotlightScrim(s, nodes)!;
    expect(scrim).not.toBeNull();
    // The page rect leads (dimmed area)…
    expect(scrim.d.startsWith("M0,0 H1000 V600 H0 Z")).toBe(true);
    // …then the hole (the clear region), which the even-odd fill subtracts.
    expect(scrim.d).toContain("M100,100"); // the region's top-left
    expect(scrim.color).toBe(DEFAULT_SPOTLIGHT_COLOR);
    expect(scrim.opacity).toBe(DEFAULT_SPOTLIGHT_OPACITY);
  });

  it("clamps a bad opacity rather than emitting it raw", () => {
    const s = spot({ opacity: 4 });
    const { nodes } = scene([s]);
    expect(spotlightScrim(s, nodes)!.opacity).toBe(1);
  });
});

describe("spotlight helpers", () => {
  it("makeSpotlight uses the shared defaults", () => {
    expect(makeSpotlight()).toEqual({
      color: DEFAULT_SPOTLIGHT_COLOR,
      opacity: DEFAULT_SPOTLIGHT_OPACITY,
    });
  });

  it("clampSpotlightOpacity bounds to 0..1 and defaults NaN", () => {
    expect(clampSpotlightOpacity(-1)).toBe(0);
    expect(clampSpotlightOpacity(2)).toBe(1);
    expect(clampSpotlightOpacity(0.5)).toBe(0.5);
    expect(clampSpotlightOpacity(NaN)).toBe(DEFAULT_SPOTLIGHT_OPACITY);
  });

  it("matchSpotlightTint identifies stock colors and rejects custom", () => {
    expect(matchSpotlightTint(SPOTLIGHT_TINTS[0]!.color)).toBe("dark");
    expect(matchSpotlightTint("#123456")).toBeNull();
  });
});
