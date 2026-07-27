import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeFrame,
  makeImage,
  makeRectangle,
  type SceneNode,
} from "../types";
import {
  absorbRootsIntoPage,
  applyCropAspect,
  cropAspectRatio,
  cropChanges,
  MIN_CROP,
  moveCrop,
  pageFrameId,
  pointInCrop,
  rectOfNode,
  resizeCrop,
  roundCrop,
  sameAspect,
} from "./crop";

const BOX = { x: 0, y: 0, width: 400, height: 300 };

function scene(): { rootIds: string[]; nodes: Record<string, SceneNode> } {
  __resetNodeIdForTests();
  const frame = makeFrame(BOX, { name: "Page" });
  const photo = makeImage(BOX, "data:image/png;base64,AA", { name: "Photo" });
  frame.children = [photo.id];
  return {
    rootIds: [frame.id],
    nodes: { [frame.id]: frame, [photo.id]: photo },
  };
}

describe("pageFrameId", () => {
  it("finds the backmost root frame a crop resizes", () => {
    const s = scene();
    expect(pageFrameId(s.rootIds, s.nodes)).toBe(s.rootIds[0]);
  });

  it("still finds the page when annotations sit beside it as roots", () => {
    // The shape a real annotated document takes: markup drawn past the image
    // edge (or pasted, or ungrouped) lands as a later sibling root.
    const s = scene();
    const note = makeRectangle({ x: 500, y: 0, width: 40, height: 40 });
    expect(
      pageFrameId([...s.rootIds, note.id], { ...s.nodes, [note.id]: note })
    ).toBe(s.rootIds[0]);
  });

  it("returns null when the backmost root isn't a frame", () => {
    const s = scene();
    const loose = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    expect(pageFrameId([], s.nodes)).toBeNull();
    expect(pageFrameId([loose.id], { [loose.id]: loose })).toBeNull();
    // A frame exists, but something paints behind it — no well-defined page,
    // and absorbing roots into it would reorder the scene.
    expect(
      pageFrameId([loose.id, ...s.rootIds], { ...s.nodes, [loose.id]: loose })
    ).toBeNull();
    // Dangling id.
    expect(pageFrameId(["nope"], s.nodes)).toBeNull();
  });
});

describe("absorbRootsIntoPage", () => {
  it("folds sibling roots into the page, preserving paint order", () => {
    const s = scene();
    const pageId = s.rootIds[0]!;
    const photoId = (s.nodes[pageId] as { children: string[] }).children[0]!;
    const one = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    const two = makeRectangle({ x: 20, y: 0, width: 10, height: 10 });

    const out = absorbRootsIntoPage(
      {
        rootIds: [pageId, one.id, two.id],
        nodes: { ...s.nodes, [one.id]: one, [two.id]: two },
      },
      pageId
    );

    expect(out.rootIds).toEqual([pageId]);
    // The page's own children still paint first, then the absorbed strays in
    // the order they used to paint as roots.
    expect((out.nodes[pageId] as { children: string[] }).children).toEqual([
      photoId,
      one.id,
      two.id,
    ]);
  });

  it("is a no-op — same object — when the page is already the only root", () => {
    const s = scene();
    const doc = { rootIds: s.rootIds, nodes: s.nodes };
    expect(absorbRootsIntoPage(doc, s.rootIds[0]!)).toBe(doc);
  });

  it("leaves the document alone when the target isn't a container", () => {
    const loose = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    const other = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    const doc = {
      rootIds: [loose.id, other.id],
      nodes: { [loose.id]: loose, [other.id]: other } as Record<
        string,
        SceneNode
      >,
    };
    expect(absorbRootsIntoPage(doc, loose.id)).toBe(doc);
  });
});

describe("resizeCrop", () => {
  it("moves only the dragged edges", () => {
    expect(resizeCrop(BOX, "e", { x: 250, y: 999 })).toEqual({
      x: 0,
      y: 0,
      width: 250,
      height: 300,
    });
    expect(resizeCrop(BOX, "n", { x: 999, y: 50 })).toEqual({
      x: 0,
      y: 50,
      width: 400,
      height: 250,
    });
    expect(resizeCrop(BOX, "nw", { x: 40, y: 60 })).toEqual({
      x: 40,
      y: 60,
      width: 360,
      height: 240,
    });
    expect(resizeCrop(BOX, "se", { x: 100, y: 90 })).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 90,
    });
  });

  it("clamps at the minimum instead of inverting when an edge crosses over", () => {
    // Dragging the west edge far past the east one.
    const r = resizeCrop(BOX, "w", { x: 900, y: 0 });
    expect(r.width).toBe(MIN_CROP);
    expect(r.x).toBe(400 - MIN_CROP);
    expect(r.height).toBe(300);

    const s = resizeCrop(BOX, "s", { x: 0, y: -500 });
    expect(s.height).toBe(MIN_CROP);
    expect(s.y).toBe(0);
  });

  it("locks a corner drag to the aspect, following the further axis", () => {
    // Pointer pushes width harder than height: width drives, height derives.
    const wide = resizeCrop(BOX, "se", { x: 200, y: 20 }, 1);
    expect(wide.width).toBeCloseTo(200);
    expect(wide.height).toBeCloseTo(200);
    // Anchored at the north-west corner (the handle's opposite).
    expect(wide.x).toBeCloseTo(0);
    expect(wide.y).toBeCloseTo(0);

    // Now height is the further axis.
    const tall = resizeCrop(BOX, "se", { x: 20, y: 200 }, 1);
    expect(tall.width).toBeCloseTo(200);
    expect(tall.height).toBeCloseTo(200);
  });

  it("keeps the anchored corner fixed under an aspect lock", () => {
    const r = resizeCrop(BOX, "nw", { x: 200, y: 200 }, 2);
    // South-east corner must not move.
    expect(r.x + r.width).toBeCloseTo(400);
    expect(r.y + r.height).toBeCloseTo(300);
    expect(r.width / r.height).toBeCloseTo(2);
  });

  it("grows the free axis symmetrically on an aspect-locked edge drag", () => {
    // Dragging the east edge to width 200 at 1:1 forces height 200, centred on
    // the original vertical midpoint (150).
    const r = resizeCrop(BOX, "e", { x: 200, y: 0 }, 1);
    expect(r.width).toBeCloseTo(200);
    expect(r.height).toBeCloseTo(200);
    expect(r.y + r.height / 2).toBeCloseTo(150);
    expect(r.x).toBeCloseTo(0);
  });

  it("honours the minimum on the derived axis of an aspect lock", () => {
    // A very wide ratio would push height under the minimum — both scale up.
    const r = resizeCrop(BOX, "e", { x: MIN_CROP, y: 0 }, 8);
    expect(r.height).toBeGreaterThanOrEqual(MIN_CROP);
    expect(r.width / r.height).toBeCloseTo(8);
  });
});

describe("moveCrop", () => {
  it("translates without resizing, and is not clamped to the image", () => {
    // Sliding the window off the page is legitimate — outward crop is how page
    // padding gets authored.
    expect(moveCrop(BOX, -50, 25)).toEqual({
      x: -50,
      y: 25,
      width: 400,
      height: 300,
    });
  });
});

describe("applyCropAspect", () => {
  it("shrinks about the centre rather than growing past the framing", () => {
    const r = applyCropAspect(BOX, 1);
    expect(r.width).toBeCloseTo(300);
    expect(r.height).toBeCloseTo(300);
    expect(r.x + r.width / 2).toBeCloseTo(200);
    expect(r.y + r.height / 2).toBeCloseTo(150);
  });

  it("fits a wider ratio inside the width", () => {
    const r = applyCropAspect(BOX, 16 / 9);
    expect(r.width).toBeCloseTo(400);
    expect(r.height).toBeCloseTo(225);
    expect(r.y + r.height / 2).toBeCloseTo(150);
  });

  it("leaves the rect alone for a non-positive ratio", () => {
    expect(applyCropAspect(BOX, 0)).toEqual(BOX);
  });
});

describe("roundCrop", () => {
  it("snaps to whole scene pixels without losing a fractional edge", () => {
    expect(roundCrop({ x: 10.4, y: 20.6, width: 100.3, height: 50.2 })).toEqual({
      x: 10,
      y: 21,
      width: 101,
      height: 50,
    });
  });

  it("never rounds below the minimum", () => {
    const r = roundCrop({ x: 0, y: 0, width: 0.2, height: 0.2 });
    expect(r.width).toBe(MIN_CROP);
    expect(r.height).toBe(MIN_CROP);
  });
});

describe("helpers", () => {
  it("reads a node's frame as a rect", () => {
    const s = scene();
    expect(rectOfNode(s.nodes[s.rootIds[0]!]!)).toEqual(BOX);
  });

  it("detects whether a crop actually changes the page", () => {
    const s = scene();
    const page = s.nodes[s.rootIds[0]!]!;
    expect(cropChanges(page, BOX)).toBe(false);
    expect(cropChanges(page, { ...BOX, width: 399 })).toBe(true);
  });

  it("compares aspects with a tolerance and treats freeform as its own value", () => {
    expect(sameAspect(null, null)).toBe(true);
    expect(sameAspect(null, 1)).toBe(false);
    expect(sameAspect(1, 1.0000001)).toBe(true);
    expect(sameAspect(1, 1.5)).toBe(false);
    expect(cropAspectRatio({ x: 0, y: 0, width: 16, height: 9 })).toBeCloseTo(
      16 / 9
    );
    // Degenerate height falls back to 1 rather than dividing by zero.
    expect(cropAspectRatio({ x: 0, y: 0, width: 16, height: 0 })).toBe(1);
  });

  it("hit-tests the crop window inclusively", () => {
    expect(pointInCrop({ x: 200, y: 150 }, BOX)).toBe(true);
    expect(pointInCrop({ x: 0, y: 0 }, BOX)).toBe(true);
    expect(pointInCrop({ x: 401, y: 150 }, BOX)).toBe(false);
    expect(pointInCrop({ x: 200, y: -1 }, BOX)).toBe(false);
  });
});
