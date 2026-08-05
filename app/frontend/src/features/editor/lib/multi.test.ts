import { describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeEllipse,
  makeRectangle,
  makeShadow,
  makeSolidPaint,
  makeStroke,
  makeText,
  type SceneNode,
} from "../types";
import {
  entriesAt,
  MIXED_LABEL,
  refsOf,
  shared,
  sharedEntry,
  sharedWhere,
  toggleTarget,
  triState,
} from "./multi";

const BOX = { x: 0, y: 0, width: 100, height: 80 };

function rect(init: Partial<SceneNode> = {}): SceneNode {
  return { ...makeRectangle(BOX), ...init } as SceneNode;
}

describe("shared", () => {
  it("reports the primary's value when the selection agrees", () => {
    const sel = [rect({ opacity: 0.5 }), rect({ opacity: 0.5 })];
    expect(shared(sel, (n) => n.opacity)).toEqual({ value: 0.5, mixed: false });
  });

  it("flags mixed but still returns the primary's value to scrub from", () => {
    const sel = [rect({ opacity: 0.5 }), rect({ opacity: 1 })];
    expect(shared(sel, (n) => n.opacity)).toEqual({ value: 0.5, mixed: true });
  });

  it("returns null for an empty selection so callers bail like they do on sel[0]", () => {
    expect(shared([], (n: SceneNode) => n.opacity)).toBeNull();
  });

  it("agrees on a single-item selection whatever the value", () => {
    expect(shared([rect({ rotation: 42 })], (n) => n.rotation)).toEqual({
      value: 42,
      mixed: false,
    });
  });

  it("compares structural values through the identity projection", () => {
    const corners = { tl: 4, tr: 4, br: 4, bl: 4 };
    const sel = [
      rect({ cornerRadii: { ...corners } }),
      rect({ cornerRadii: { ...corners } }),
    ];
    const pick = (n: SceneNode) => (n as { cornerRadii: unknown }).cornerRadii;
    // Distinct references: without a projection they read as a disagreement.
    expect(shared(sel, pick)?.mixed).toBe(true);
    expect(shared(sel, pick, (v) => JSON.stringify(v))?.mixed).toBe(false);
  });

  it("treats NaN as equal to itself (Object.is, not ===)", () => {
    const sel = [rect({ rotation: NaN }), rect({ rotation: NaN })];
    expect(shared(sel, (n) => n.rotation)?.mixed).toBe(false);
  });

  it("detects a disagreement past the first pair", () => {
    const sel = [
      rect({ opacity: 1 }),
      rect({ opacity: 1 }),
      rect({ opacity: 0.2 }),
    ];
    expect(shared(sel, (n) => n.opacity)).toEqual({ value: 1, mixed: true });
  });
});

describe("sharedWhere", () => {
  it("lets nodes without the property sit out instead of reading as mixed", () => {
    __resetNodeIdForTests();
    const a = makeText(BOX, { text: "one" });
    const b = makeText(BOX, { text: "two" });
    const sel: SceneNode[] = [a, makeRectangle(BOX), b];
    // The rectangle carries no fontSize; the two texts agree, so the field is
    // editable rather than frozen at "Mixed".
    const s = sharedWhere(sel, (n) =>
      n.type === "text" ? n.fontSize : undefined
    );
    expect(s).toEqual({ value: a.fontSize, mixed: false });
    expect(b.fontSize).toBe(a.fontSize);
  });

  it("still reports mixed when the carriers disagree", () => {
    const a = makeText(BOX, { text: "one", fontSize: 12 });
    const b = makeText(BOX, { text: "two", fontSize: 24 });
    const sel: SceneNode[] = [a, makeRectangle(BOX), b];
    const s = sharedWhere(sel, (n) =>
      n.type === "text" ? n.fontSize : undefined
    );
    expect(s).toEqual({ value: 12, mixed: true });
  });

  it("returns null when nothing in the selection carries the property", () => {
    const sel: SceneNode[] = [makeRectangle(BOX), makeEllipse(BOX)];
    expect(
      sharedWhere(sel, (n) => (n.type === "text" ? n.fontSize : undefined))
    ).toBeNull();
  });

  it("reads the first carrier, not the first node, as the primary value", () => {
    const sel: SceneNode[] = [
      makeRectangle(BOX),
      makeText(BOX, { fontSize: 30 }),
    ];
    const s = sharedWhere(sel, (n) =>
      n.type === "text" ? n.fontSize : undefined
    );
    expect(s?.value).toBe(30);
  });
});

describe("entriesAt / refsOf (edit-by-index, Fork P-F1)", () => {
  function selWithStrokes(): SceneNode[] {
    const a = {
      ...makeRectangle(BOX),
      strokes: [makeStroke("#111111", 1), makeStroke("#222222", 2)],
    };
    const b = { ...makeRectangle(BOX), strokes: [makeStroke("#333333", 3)] };
    return [a, b] as SceneNode[];
  }

  it("collects the entry at a row from every node that has one", () => {
    const sel = selWithStrokes();
    const peers = entriesAt(sel, "strokes", 0);
    expect(peers.map((p) => p.entry.width)).toEqual([1, 3]);
  });

  it("skips nodes with a shorter list rather than inventing rows for them", () => {
    const sel = selWithStrokes();
    const peers = entriesAt(sel, "strokes", 1);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.nodeId).toBe(sel[0]!.id);
  });

  it("returns nothing for a row past every list", () => {
    expect(entriesAt(selWithStrokes(), "strokes", 9)).toEqual([]);
  });

  it("addresses fills and effects the same way", () => {
    const a = {
      ...makeRectangle(BOX),
      fills: [makeSolidPaint("#ff0000")],
      effects: [makeShadow()],
    } as SceneNode;
    const b = {
      ...makeRectangle(BOX),
      fills: [makeSolidPaint("#00ff00")],
      effects: [],
    } as SceneNode;
    expect(entriesAt([a, b], "fills", 0)).toHaveLength(2);
    expect(entriesAt([a, b], "effects", 0)).toHaveLength(1);
  });

  it("strips peers to the {nodeId, entryId} refs the store writes through", () => {
    const sel = selWithStrokes();
    const peers = entriesAt(sel, "strokes", 0);
    expect(refsOf(peers)).toEqual([
      { nodeId: sel[0]!.id, entryId: sel[0]!.strokes[0]!.id },
      { nodeId: sel[1]!.id, entryId: sel[1]!.strokes[0]!.id },
    ]);
  });

  it("reads a row's shared value across the peers", () => {
    const sel = selWithStrokes();
    const peers = entriesAt(sel, "strokes", 0);
    expect(sharedEntry(peers, (s) => s.width)).toEqual({
      value: 1,
      mixed: true,
    });
    expect(sharedEntry(peers, (s) => s.visible)).toEqual({
      value: true,
      mixed: false,
    });
  });
});

describe("triState / toggleTarget", () => {
  it("reads all-on, all-off, and split", () => {
    expect(
      triState(
        [rect({ visible: true }), rect({ visible: true })],
        (n) => n.visible
      )
    ).toBe("on");
    expect(
      triState(
        [rect({ visible: false }), rect({ visible: false })],
        (n) => n.visible
      )
    ).toBe("off");
    expect(
      triState(
        [rect({ visible: true }), rect({ visible: false })],
        (n) => n.visible
      )
    ).toBe("mixed");
  });

  it("reads an empty selection as off rather than throwing", () => {
    expect(triState([], (n: SceneNode) => n.visible)).toBe("off");
  });

  it("unifies a split selection on, so one press always shows a visible result", () => {
    expect(toggleTarget("mixed")).toBe(true);
    expect(toggleTarget("off")).toBe(true);
    expect(toggleTarget("on")).toBe(false);
  });
});

describe("MIXED_LABEL", () => {
  it("is the Figma-style placeholder the fields render", () => {
    expect(MIXED_LABEL).toBe("Mixed");
  });
});
