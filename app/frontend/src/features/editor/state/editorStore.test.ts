import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  createNodeForTool,
  makeFrame,
  makeGradientPaint,
  makeRectangle,
  type FrameNode,
  type RectangleNode,
  type SceneNode,
} from "../types";
import {
  editorSelectors,
  useEditorStore,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
} from "./editorStore";

interface Seed {
  a: RectangleNode;
  b: RectangleNode;
  frame: FrameNode;
  c: RectangleNode;
}

let seed: Seed;

function loadSeed(): Seed {
  __resetNodeIdForTests();
  const a = makeRectangle({ x: 0, y: 0, width: 20, height: 20 }, { name: "A" });
  const b = makeRectangle(
    { x: 100, y: 0, width: 20, height: 20 },
    { name: "B" }
  );
  const frame = makeFrame(
    { x: 0, y: 0, width: 200, height: 200 },
    { name: "F" }
  );
  frame.children = [a.id, b.id];
  const c = makeRectangle(
    { x: 300, y: 300, width: 20, height: 20 },
    { name: "C" }
  );
  const rootIds = [frame.id, c.id];
  const nodes: Record<string, SceneNode> = {
    [a.id]: a,
    [b.id]: b,
    [frame.id]: frame,
    [c.id]: c,
  };
  useEditorStore.getState().loadScene({
    rootIds,
    nodes,
    docName: "Test",
    sourceId: null,
  });
  return { a, b, frame, c };
}

beforeEach(() => {
  seed = loadSeed();
});

const node = (id: string): SceneNode => useEditorStore.getState().nodes[id]!;

describe("loadScene", () => {
  it("seeds nodes and clears history", () => {
    const s = useEditorStore.getState();
    expect(s.rootIds).toEqual([seed.frame.id, seed.c.id]);
    expect(s.past).toHaveLength(0);
    expect(s.docStatus).toBe("draft");
    expect(editorSelectors.childIds(s, seed.frame.id)).toEqual([
      seed.a.id,
      seed.b.id,
    ]);
  });
});

describe("selection", () => {
  it("replaces, toggles, and clears", () => {
    const st = useEditorStore.getState();
    st.select([seed.a.id]);
    expect(useEditorStore.getState().selectedIds).toEqual([seed.a.id]);
    st.toggleSelection(seed.b.id);
    expect(useEditorStore.getState().selectedIds).toEqual([
      seed.a.id,
      seed.b.id,
    ]);
    st.toggleSelection(seed.a.id);
    expect(useEditorStore.getState().selectedIds).toEqual([seed.b.id]);
    st.clearSelection();
    expect(useEditorStore.getState().selectedIds).toEqual([]);
  });
});

describe("modes", () => {
  it("defaults to annotate", () => {
    expect(useEditorStore.getState().mode).toBe("annotate");
  });

  it("keeps a shared tool when switching modes", () => {
    useEditorStore.getState().setTool("arrow"); // shared by both modes
    useEditorStore.getState().setMode("design");
    expect(useEditorStore.getState().mode).toBe("design");
    expect(useEditorStore.getState().tool).toBe("arrow");
  });

  it("falls back to select when the active tool isn't in the new mode", () => {
    useEditorStore.getState().setTool("blur"); // annotate-only
    useEditorStore.getState().setMode("design");
    expect(useEditorStore.getState().tool).toBe("select");
  });

  it("restores each mode's own viewport across a round trip", () => {
    const st = () => useEditorStore.getState();
    // Frame something in Annotate...
    st().setZoom(2);
    st().setPan(120, 60);
    const annotate = st().viewport;

    // ...switch to Design and move somewhere else.
    st().setMode("design");
    st().setPan(-300, -400);
    const design = st().viewport;
    expect(design).not.toEqual(annotate);

    // Back to Annotate: the original framing returns, not Design's.
    st().setMode("annotate");
    expect(st().viewport).toEqual(annotate);

    // And Design's is still waiting where it was left.
    st().setMode("design");
    expect(st().viewport).toEqual(design);
  });

  it("carries the current viewport into a mode that hasn't been visited", () => {
    // No snap-to-fit on first entry — the user keeps the framing they had.
    const st = () => useEditorStore.getState();
    st().setPan(42, 84);
    const before = st().viewport;
    st().setMode("design");
    expect(st().viewport).toEqual(before);
  });

  it("drops remembered viewports when a new document loads", () => {
    const st = () => useEditorStore.getState();
    st().setPan(42, 84);
    st().setMode("design");
    loadSeed();
    expect(st().viewportByMode).toEqual({});
    expect(st().viewport).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });
});

describe("addNode", () => {
  it("nests a node under the frame it is drawn over", () => {
    const drawn = makeRectangle({ x: 10, y: 10, width: 10, height: 10 });
    useEditorStore.getState().addNode(drawn);
    const frame = node(seed.frame.id) as FrameNode;
    expect(frame.children).toContain(drawn.id);
    expect(useEditorStore.getState().selectedIds).toEqual([drawn.id]);
  });

  it("adds to the page root when drawn on empty canvas", () => {
    const drawn = makeRectangle({ x: 500, y: 500, width: 10, height: 10 });
    useEditorStore.getState().addNode(drawn);
    expect(useEditorStore.getState().rootIds).toContain(drawn.id);
  });

  it("honors an explicit parent of null (force root)", () => {
    const drawn = makeRectangle({ x: 10, y: 10, width: 10, height: 10 });
    useEditorStore.getState().addNode(drawn, null);
    expect(useEditorStore.getState().rootIds).toContain(drawn.id);
  });

  it("auto-increments step-badge numbers as they are added", () => {
    const at = (i: number) => ({
      x: 400 + i * 40,
      y: 400,
      width: 30,
      height: 30,
    });
    const first = createNodeForTool("step", at(0))!;
    useEditorStore.getState().addNode(first, null);
    expect(node(first.id).step?.number).toBe(1);

    const second = createNodeForTool("step", at(1))!;
    useEditorStore.getState().addNode(second, null);
    expect(node(second.id).step?.number).toBe(2);

    // Deleting #1 then adding another continues past the highest (→ 3, no reuse).
    useEditorStore.getState().removeNodes([first.id]);
    const third = createNodeForTool("step", at(2))!;
    useEditorStore.getState().addNode(third, null);
    expect(node(third.id).step?.number).toBe(3);
  });

  it("draws a stamp with the picker's current icon, naming the layer for it", () => {
    // Same seam step badges get their number from: `createNodeForTool` is pure
    // and seeds the default, and `addNode` swaps in the session's choice.
    const at = { x: 400, y: 400, width: 48, height: 48 };
    const first = createNodeForTool("stamp", at)!;
    useEditorStore.getState().addNode(first, null);
    expect(node(first.id).stamp?.kind).toBe("check");
    expect(node(first.id).name).toBe("Check");

    useEditorStore.getState().setStampKind("warning");
    const second = createNodeForTool("stamp", at)!;
    useEditorStore.getState().addNode(second, null);
    expect(node(second.id).stamp?.kind).toBe("warning");
    expect(node(second.id).name).toBe("Warning");
  });

  it("does not seal the page for a stamp — it is a local mark", () => {
    // Unlike a spotlight (whose scrim covers the page) or a crop, a stamp paints
    // only inside its own frame, so there is no export region to reconcile.
    const before = useEditorStore.getState().rootIds.length;
    const s = createNodeForTool("stamp", {
      x: 400,
      y: 400,
      width: 48,
      height: 48,
    })!;
    useEditorStore.getState().addNode(s, null);
    expect(useEditorStore.getState().rootIds).toHaveLength(before + 1);
    expect(useEditorStore.getState().rootIds).toContain(seed.c.id);
  });

  it("seals the page when a spotlight is added (no undimmed export band)", () => {
    // Seed has a stray root `c` beside the page frame. A spotlight dims the page
    // frame's rect, so that rect must be the whole document — adding one absorbs
    // the stray so `unionBounds(rootIds) === pageRect` (see lib/spotlight.ts).
    const spot = createNodeForTool("spotlight", {
      x: 20,
      y: 20,
      width: 80,
      height: 60,
    })!;
    useEditorStore.getState().addNode(spot, null);
    const s = useEditorStore.getState();
    // The page frame is now the sole root; the stray + the spotlight live inside.
    expect(s.rootIds).toEqual([seed.frame.id]);
    const frame = node(seed.frame.id) as FrameNode;
    expect(frame.children).toContain(seed.c.id);
    expect(frame.children).toContain(spot.id);
    expect(node(spot.id).spotlight).not.toBeNull();

    // …and it's one undo step: the whole add+seal reverts together.
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().rootIds).toEqual([
      seed.frame.id,
      seed.c.id,
    ]);
  });
});

describe("gradient edit state", () => {
  it("sets and clears the on-canvas gradient-edit fill id", () => {
    useEditorStore.getState().setGradientEditFill("fill_x");
    expect(useEditorStore.getState().gradientEditFillId).toBe("fill_x");
    useEditorStore.getState().setGradientEditFill(null);
    expect(useEditorStore.getState().gradientEditFillId).toBeNull();
  });

  it("clears on loadScene", () => {
    useEditorStore.getState().setGradientEditFill("fill_y");
    loadSeed();
    expect(useEditorStore.getState().gradientEditFillId).toBeNull();
  });
});

describe("color editor", () => {
  const fillId = () => node(seed.a.id).fills[0]!.id;

  it("opens with a target + anchor and closes", () => {
    useEditorStore
      .getState()
      .openColorEditor(
        { kind: "fill", nodeId: seed.a.id, fillId: fillId() },
        100,
        200
      );
    const ce = useEditorStore.getState().colorEditor;
    expect(ce?.target).toMatchObject({ kind: "fill", fillId: fillId() });
    expect(ce).toMatchObject({ x: 100, y: 200 });
    useEditorStore.getState().closeColorEditor();
    expect(useEditorStore.getState().colorEditor).toBeNull();
  });

  it("lights up the gradient handles only for a gradient fill", () => {
    const fid = fillId();
    useEditorStore.getState().updateFill(seed.a.id, fid, {
      type: "gradient",
      gradient: makeGradientPaint().gradient,
    });
    useEditorStore
      .getState()
      .openColorEditor({ kind: "fill", nodeId: seed.a.id, fillId: fid }, 0, 0);
    expect(useEditorStore.getState().gradientEditFillId).toBe(fid);
    useEditorStore.getState().closeColorEditor();
    expect(useEditorStore.getState().gradientEditFillId).toBeNull();
  });

  it("dismisses when the selection changes", () => {
    useEditorStore
      .getState()
      .openColorEditor(
        { kind: "fill", nodeId: seed.a.id, fillId: fillId() },
        0,
        0
      );
    useEditorStore.getState().select([seed.b.id]);
    expect(useEditorStore.getState().colorEditor).toBeNull();
  });

  it("opens stroke/effect/text targets without gradient handles", () => {
    useEditorStore
      .getState()
      .openColorEditor(
        { kind: "stroke", nodeId: seed.a.id, strokeId: "s1" },
        0,
        0
      );
    expect(useEditorStore.getState().colorEditor?.target.kind).toBe("stroke");
    expect(useEditorStore.getState().gradientEditFillId).toBeNull();
  });
});

describe("moveNodes + history", () => {
  it("records one undo step for a transient drag gesture", () => {
    const st = useEditorStore.getState();
    st.select([seed.a.id]);
    st.pushHistory();
    st.moveNodes([seed.a.id], 5, 5, { transient: true });
    st.moveNodes([seed.a.id], 5, 5, { transient: true });
    expect(node(seed.a.id).x).toBe(10);
    expect(useEditorStore.getState().past).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(node(seed.a.id).x).toBe(0);
  });

  it("skips locked nodes", () => {
    useEditorStore.getState().setLocked(seed.a.id, true);
    useEditorStore.getState().moveNodes([seed.a.id], 10, 10);
    expect(node(seed.a.id).x).toBe(0);
  });

  it("carries a moved container's descendants along", () => {
    // Move frame F; its children a (0,0) and b (100,0) must travel with it,
    // while the unrelated root node c stays put.
    useEditorStore.getState().moveNodes([seed.frame.id], 10, 5);
    expect(node(seed.frame.id).x).toBe(10);
    expect(node(seed.a.id).x).toBe(10);
    expect(node(seed.a.id).y).toBe(5);
    expect(node(seed.b.id).x).toBe(110);
    expect(node(seed.c.id).x).toBe(300);
  });

  it("leaves a locked container and its subtree in place", () => {
    useEditorStore.getState().setLocked(seed.frame.id, true);
    useEditorStore.getState().moveNodes([seed.frame.id], 40, 40);
    expect(node(seed.frame.id).x).toBe(0);
    expect(node(seed.a.id).x).toBe(0);
  });
});

describe("undo / redo", () => {
  it("round-trips a discrete edit", () => {
    useEditorStore.getState().updateNode(seed.a.id, { x: 99 });
    expect(node(seed.a.id).x).toBe(99);
    useEditorStore.getState().undo();
    expect(node(seed.a.id).x).toBe(0);
    useEditorStore.getState().redo();
    expect(node(seed.a.id).x).toBe(99);
  });

  it("exposes canUndo / canRedo via past/future length", () => {
    expect(useEditorStore.getState().past.length > 0).toBe(false);
    useEditorStore.getState().updateNode(seed.a.id, { x: 1 });
    expect(useEditorStore.getState().past.length > 0).toBe(true);
    expect(useEditorStore.getState().future.length > 0).toBe(false);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().future.length > 0).toBe(true);
  });

  it("caps the undo stack so history can't grow without bound", () => {
    // Push far more discrete edits than the retention cap (100).
    for (let i = 1; i <= 150; i++) {
      useEditorStore.getState().updateNode(seed.a.id, { x: i });
    }
    // Oldest snapshots are dropped — the stack is bounded, not 150 deep.
    expect(useEditorStore.getState().past.length).toBe(100);
    // The most recent edits still undo correctly.
    expect(node(seed.a.id).x).toBe(150);
    useEditorStore.getState().undo();
    expect(node(seed.a.id).x).toBe(149);
  });
});

describe("history transactions", () => {
  it("coalesces every change in a begin/endHistory span into one undo step", () => {
    const st = useEditorStore.getState();
    st.beginHistory();
    st.updateNode(seed.a.id, { x: 10 });
    st.updateNode(seed.a.id, { x: 20 });
    st.updateNode(seed.a.id, { x: 30 });
    st.endHistory();
    expect(node(seed.a.id).x).toBe(30);
    expect(useEditorStore.getState().past).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(node(seed.a.id).x).toBe(0);
  });

  it("records nothing when the transaction makes no change (lazy snapshot)", () => {
    const before = useEditorStore.getState().past.length;
    useEditorStore.getState().beginHistory();
    useEditorStore.getState().endHistory();
    expect(useEditorStore.getState().past).toHaveLength(before);
    expect(useEditorStore.getState().txnDepth).toBe(0);
  });

  it("coalesces across different mutators", () => {
    const st = useEditorStore.getState();
    const fills0 = node(seed.a.id).fills.length;
    st.beginHistory();
    st.updateNode(seed.a.id, { x: 7 });
    st.addFill(seed.a.id);
    st.endHistory();
    expect(useEditorStore.getState().past).toHaveLength(1);
    expect(node(seed.a.id).fills.length).toBe(fills0 + 1);
    useEditorStore.getState().undo();
    expect(node(seed.a.id).x).toBe(0);
    expect(node(seed.a.id).fills.length).toBe(fills0);
  });

  it("balances nested transactions and still snapshots once", () => {
    const st = useEditorStore.getState();
    st.beginHistory();
    st.beginHistory();
    st.updateNode(seed.a.id, { x: 5 });
    st.endHistory();
    st.updateNode(seed.a.id, { x: 6 });
    st.endHistory();
    expect(useEditorStore.getState().txnDepth).toBe(0);
    expect(useEditorStore.getState().past).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(node(seed.a.id).x).toBe(0);
  });
});

describe("removeNodes", () => {
  it("cascades children and detaches from parent + selection", () => {
    useEditorStore.getState().select([seed.frame.id, seed.a.id]);
    useEditorStore.getState().removeNodes([seed.frame.id]);
    const s = useEditorStore.getState();
    expect(s.nodes[seed.frame.id]).toBeUndefined();
    expect(s.nodes[seed.a.id]).toBeUndefined();
    expect(s.nodes[seed.b.id]).toBeUndefined();
    expect(s.rootIds).toEqual([seed.c.id]);
    expect(s.selectedIds).toEqual([]);
  });
});

describe("reorderNode", () => {
  it("reorders siblings within the same parent", () => {
    useEditorStore.getState().reorderNode(seed.b.id, seed.a.id, "before");
    expect((node(seed.frame.id) as FrameNode).children).toEqual([
      seed.b.id,
      seed.a.id,
    ]);
  });

  it("refuses to drop a node inside its own subtree", () => {
    useEditorStore.getState().reorderNode(seed.frame.id, seed.a.id, "after");
    // frame stays at root; children untouched.
    expect(useEditorStore.getState().rootIds).toContain(seed.frame.id);
    expect((node(seed.frame.id) as FrameNode).children).toEqual([
      seed.a.id,
      seed.b.id,
    ]);
  });
});

describe("align", () => {
  it("right-aligns the selection to its union bounds", () => {
    useEditorStore.getState().select([seed.a.id, seed.b.id]);
    useEditorStore.getState().align("right");
    // union right edge = 120; both width 20 → x = 100.
    expect(node(seed.a.id).x).toBe(100);
    expect(node(seed.b.id).x).toBe(100);
  });

  it("center-h aligns to the union midline", () => {
    useEditorStore.getState().select([seed.a.id, seed.b.id]);
    useEditorStore.getState().align("center-h");
    expect(node(seed.a.id).x).toBe(50);
    expect(node(seed.b.id).x).toBe(50);
  });

  it("single selection aligns within its parent frame", () => {
    useEditorStore.getState().select([seed.a.id]);
    useEditorStore.getState().align("right");
    // frame width 200, node width 20 → x = 180.
    expect(node(seed.a.id).x).toBe(180);
  });

  it("distributes three nodes evenly", () => {
    // a:0-20, b:100-120, c at 300 → move c to 200 for a clean span.
    useEditorStore.getState().updateNode(seed.c.id, { x: 200, y: 0 });
    useEditorStore.getState().select([seed.a.id, seed.b.id, seed.c.id]);
    useEditorStore.getState().align("distribute-h");
    // span 0..220, sizes 20*3=60, gap=(220-60)/2=80 → b at 100.
    expect(node(seed.b.id).x).toBe(100);
  });
});

describe("paints / strokes / effects", () => {
  it("adds, updates, and removes a fill", () => {
    useEditorStore.getState().addFill(seed.a.id);
    const fillId = node(seed.a.id).fills.at(-1)!.id;
    useEditorStore
      .getState()
      .updateFill(seed.a.id, fillId, { color: "#123456" });
    expect(node(seed.a.id).fills.find((f) => f.id === fillId)!.color).toBe(
      "#123456"
    );
    useEditorStore.getState().removeFill(seed.a.id, fillId);
    expect(node(seed.a.id).fills.some((f) => f.id === fillId)).toBe(false);
  });

  it("adds and removes a stroke and an effect", () => {
    useEditorStore.getState().addStroke(seed.a.id);
    expect(node(seed.a.id).strokes).toHaveLength(1);
    useEditorStore.getState().addEffect(seed.a.id, "layer-blur");
    expect(node(seed.a.id).effects[0]!.type).toBe("layer-blur");
    const fxId = node(seed.a.id).effects[0]!.id;
    useEditorStore.getState().removeEffect(seed.a.id, fxId);
    expect(node(seed.a.id).effects).toHaveLength(0);
  });
});

describe("viewport", () => {
  it("zooms toward an anchor, keeping the scene point stationary", () => {
    useEditorStore.getState().setZoom(2, { x: 100, y: 100, vw: 800, vh: 600 });
    const vp = useEditorStore.getState().viewport;
    expect(vp.zoom).toBe(2);
    expect(vp.panX).toBe(-100);
    expect(vp.panY).toBe(-100);
  });

  it("steps through zoom presets", () => {
    useEditorStore.getState().zoomIn();
    expect(useEditorStore.getState().viewport.zoom).toBe(1.5);
    useEditorStore.getState().resetZoom();
    useEditorStore.getState().zoomOut();
    expect(useEditorStore.getState().viewport.zoom).toBe(0.75);
  });

  it("fits the page contents into the viewport", () => {
    useEditorStore.getState().zoomToFit(800, 600);
    const vp = useEditorStore.getState().viewport;
    expect(vp.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(vp.panX)).toBe(true);
  });
});

describe("selectedNodes selector", () => {
  it("resolves ids to live nodes, dropping stale ids", () => {
    useEditorStore.getState().select([seed.a.id, "ghost"]);
    const sel = editorSelectors.selectedNodes(useEditorStore.getState());
    expect(sel).toHaveLength(1);
    expect(sel[0]!.id).toBe(seed.a.id);
  });
});

describe("duplicateNodes", () => {
  it("clones a node into its parent, offset, with fresh paint ids, and selects it", () => {
    useEditorStore.getState().duplicateNodes([seed.a.id]);
    const frame = node(seed.frame.id) as FrameNode;
    expect(frame.children).toHaveLength(3);
    const sel = useEditorStore.getState().selectedIds;
    expect(sel).toHaveLength(1);
    const cloneId = sel[0]!;
    expect(cloneId).not.toBe(seed.a.id);
    // Inserted directly after the original.
    expect(frame.children[frame.children.indexOf(seed.a.id) + 1]).toBe(cloneId);
    const clone = node(cloneId);
    expect(clone.x).toBe(seed.a.x + 24);
    expect(clone.y).toBe(seed.a.y + 24);
    // Paint ids are regenerated, not shared with the original.
    expect(clone.fills[0]?.id).not.toBe(seed.a.fills[0]?.id);
  });

  it("is a single undo step", () => {
    useEditorStore.getState().duplicateNodes([seed.a.id]);
    expect((node(seed.frame.id) as FrameNode).children).toHaveLength(3);
    useEditorStore.getState().undo();
    expect((node(seed.frame.id) as FrameNode).children).toHaveLength(2);
  });
});

describe("copy / paste", () => {
  it("copies the selection and pastes a clone at the cursor", () => {
    useEditorStore.getState().copyNodes([seed.c.id]);
    expect(useEditorStore.getState().clipboard).not.toBeNull();
    useEditorStore.getState().pasteClipboard({ x: 0, y: 0 });
    expect(useEditorStore.getState().rootIds).toHaveLength(3);
    const pasteId = useEditorStore.getState().selectedIds[0]!;
    expect(pasteId).not.toBe(seed.c.id);
    // c was at (300,300); pasting "here" puts its top-left at the cursor.
    expect(node(pasteId).x).toBe(0);
    expect(node(pasteId).y).toBe(0);
  });

  it("re-clones on each paste so repeated pastes get unique ids", () => {
    useEditorStore.getState().copyNodes([seed.c.id]);
    useEditorStore.getState().pasteClipboard();
    const first = useEditorStore.getState().selectedIds[0]!;
    useEditorStore.getState().pasteClipboard();
    const second = useEditorStore.getState().selectedIds[0]!;
    expect(second).not.toBe(first);
    expect(useEditorStore.getState().rootIds).toHaveLength(4);
  });
});

describe("z-order", () => {
  it("brings a root node to front (end of the array)", () => {
    useEditorStore.getState().bringToFront([seed.frame.id]);
    expect(useEditorStore.getState().rootIds).toEqual([
      seed.c.id,
      seed.frame.id,
    ]);
  });

  it("sends a root node to back (start of the array)", () => {
    useEditorStore.getState().sendToBack([seed.c.id]);
    expect(useEditorStore.getState().rootIds).toEqual([
      seed.c.id,
      seed.frame.id,
    ]);
  });

  it("nudges a child forward within its frame without leaving the parent", () => {
    useEditorStore.getState().bringForward([seed.a.id]);
    expect((node(seed.frame.id) as FrameNode).children).toEqual([
      seed.b.id,
      seed.a.id,
    ]);
  });
});

describe("context menu state", () => {
  it("opens and closes", () => {
    useEditorStore
      .getState()
      .openContextMenu({ x: 10, y: 20, sceneX: 1, sceneY: 2, kind: "node" });
    expect(useEditorStore.getState().contextMenu?.kind).toBe("node");
    useEditorStore.getState().closeContextMenu();
    expect(useEditorStore.getState().contextMenu).toBeNull();
  });
});

describe("canvas affordances", () => {
  it("toggles the dot grid and persists across loadScene", () => {
    const s = () => useEditorStore.getState();
    expect(s().showGrid).toBe(true);
    s().toggleGrid();
    expect(s().showGrid).toBe(false);
    // A new document keeps the user's grid preference.
    loadSeed();
    expect(s().showGrid).toBe(false);
    s().setShowGrid(true);
    expect(s().showGrid).toBe(true);
  });

  it("setGuides skips a no-op empty→empty write (stable reference)", () => {
    const s = () => useEditorStore.getState();
    const before = s().guides;
    s().setGuides([]);
    expect(s().guides).toBe(before);
    s().setGuides([{ axis: "x", pos: 10, start: 0, end: 20, kind: "edge" }]);
    expect(s().guides).toHaveLength(1);
    s().setGuides([]);
    expect(s().guides).toHaveLength(0);
  });

  it("clears guides + hud + cursor on loadScene", () => {
    const s = () => useEditorStore.getState();
    s().setGuides([{ axis: "y", pos: 5, start: 0, end: 9, kind: "center" }]);
    s().setTransformHud({ text: "1 × 1", sx: 0, sy: 0 });
    s().setCursor({ x: 3, y: 4 });
    loadSeed();
    expect(s().guides).toHaveLength(0);
    expect(s().transformHud).toBeNull();
    expect(s().cursor).toBeNull();
  });

  it("requestRename then clearRename round-trips", () => {
    const s = () => useEditorStore.getState();
    s().requestRename(seed.a.id);
    expect(s().renamingId).toBe(seed.a.id);
    s().clearRename();
    expect(s().renamingId).toBeNull();
  });
});

describe("duplicate offset", () => {
  it("clones in place when offset is 0 (alt-drag start)", () => {
    useEditorStore.getState().duplicateNodes([seed.c.id], 0);
    const cloneId = useEditorStore.getState().selectedIds[0]!;
    expect(cloneId).not.toBe(seed.c.id);
    expect(node(cloneId).x).toBe(node(seed.c.id).x);
    expect(node(cloneId).y).toBe(node(seed.c.id).y);
  });
});

describe("lock / hide selected", () => {
  it("locks the whole selection, then unlocks once all are locked", () => {
    const s = useEditorStore.getState();
    s.select([seed.a.id, seed.c.id]);
    s.toggleLockSelected();
    expect(node(seed.a.id).locked).toBe(true);
    expect(node(seed.c.id).locked).toBe(true);
    s.toggleLockSelected();
    expect(node(seed.a.id).locked).toBe(false);
  });

  it("hides the selection, then shows once all are hidden, in one undo step", () => {
    const s = useEditorStore.getState();
    s.select([seed.a.id]);
    s.toggleHideSelected();
    expect(node(seed.a.id).visible).toBe(false);
    useEditorStore.getState().undo();
    expect(node(seed.a.id).visible).toBe(true);
  });

  it("does nothing without a selection", () => {
    const s = useEditorStore.getState();
    s.clearSelection();
    const past = useEditorStore.getState().past.length;
    s.toggleLockSelected();
    expect(useEditorStore.getState().past.length).toBe(past);
  });
});

describe("resizeSelectedBy", () => {
  it("grows the selection by dw×dh", () => {
    const s = useEditorStore.getState();
    s.select([seed.a.id]); // 20×20
    s.resizeSelectedBy(10, 6);
    expect(node(seed.a.id).width).toBe(30);
    expect(node(seed.a.id).height).toBe(26);
  });

  it("derives the other axis when proportional", () => {
    const s = useEditorStore.getState();
    s.select([seed.a.id]); // 20×20, ratio 1
    s.resizeSelectedBy(10, 0, { proportional: true });
    expect(node(seed.a.id).width).toBe(30);
    expect(node(seed.a.id).height).toBe(30);
  });

  it("respects the minimum size (no inversion)", () => {
    const s = useEditorStore.getState();
    s.select([seed.a.id]);
    s.resizeSelectedBy(-100, -100);
    expect(node(seed.a.id).width).toBeGreaterThanOrEqual(1);
    expect(node(seed.a.id).height).toBeGreaterThanOrEqual(1);
  });

  it("skips locked nodes and is one undo step", () => {
    const s = useEditorStore.getState();
    s.setLocked(seed.a.id, true);
    s.select([seed.a.id]);
    const past = useEditorStore.getState().past.length;
    s.resizeSelectedBy(10, 10);
    expect(node(seed.a.id).width).toBe(20); // unchanged (locked)
    expect(useEditorStore.getState().past.length).toBe(past); // no-op, no entry
  });

  it("coalesces a begin/endHistory burst into a single undo entry", () => {
    const s = useEditorStore.getState();
    s.select([seed.a.id]);
    s.beginHistory();
    s.resizeSelectedBy(5, 5);
    s.resizeSelectedBy(5, 5);
    s.endHistory();
    expect(node(seed.a.id).width).toBe(30);
    expect(useEditorStore.getState().past).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(node(seed.a.id).width).toBe(20);
  });
});

describe("zoomToSelection", () => {
  it("fits the selection into the viewport", () => {
    const s = useEditorStore.getState();
    s.select([seed.c.id]);
    s.zoomToSelection(800, 600);
    const vp = useEditorStore.getState().viewport;
    expect(vp.zoom).toBeGreaterThan(0);
    expect(Number.isFinite(vp.panX)).toBe(true);
  });

  it("is a no-op when nothing is selected", () => {
    const s = useEditorStore.getState();
    s.clearSelection();
    const before = useEditorStore.getState().viewport;
    s.zoomToSelection(800, 600);
    expect(useEditorStore.getState().viewport).toBe(before);
  });
});

describe("keyboard / overlay flags", () => {
  it("toggles temp-pan, help, and bumps the export request", () => {
    const s = useEditorStore.getState();
    s.setTempPan(true);
    expect(useEditorStore.getState().tempPan).toBe(true);
    s.setTempPan(false);
    expect(useEditorStore.getState().tempPan).toBe(false);

    expect(useEditorStore.getState().helpOpen).toBe(false);
    s.toggleHelp();
    expect(useEditorStore.getState().helpOpen).toBe(true);

    const n = useEditorStore.getState().exportRequest;
    s.requestExport();
    expect(useEditorStore.getState().exportRequest).toBe(n + 1);
  });
});

describe("group / ungroup", () => {
  it("wraps a root selection in a non-clipping Group frame, preserving order", () => {
    const s = useEditorStore.getState();
    s.select([seed.frame.id, seed.c.id]);
    s.group();
    const st = useEditorStore.getState();
    expect(st.rootIds).toHaveLength(1);
    const g = node(st.rootIds[0]!) as FrameNode;
    expect(g.type).toBe("frame");
    expect(g.name).toBe("Group");
    expect(g.clipContent).toBe(false);
    expect(g.children).toEqual([seed.frame.id, seed.c.id]);
    expect(st.selectedIds).toEqual([g.id]);
  });

  it("groups same-parent siblings inside their parent in one undo step", () => {
    const s = useEditorStore.getState();
    s.select([seed.a.id, seed.b.id]); // both children of the frame
    s.group();
    const frame = node(seed.frame.id) as FrameNode;
    expect(frame.children).toHaveLength(1);
    const g = node(frame.children[0]!) as FrameNode;
    expect(g.children).toEqual([seed.a.id, seed.b.id]);
    // Roots are untouched (the group nests inside the frame).
    expect(useEditorStore.getState().rootIds).toEqual([
      seed.frame.id,
      seed.c.id,
    ]);
    useEditorStore.getState().undo();
    expect((node(seed.frame.id) as FrameNode).children).toEqual([
      seed.a.id,
      seed.b.id,
    ]);
  });

  it("ungroup dissolves a group back into its slot and selects the children", () => {
    const s = useEditorStore.getState();
    s.select([seed.a.id, seed.b.id]);
    s.group();
    const gId = (node(seed.frame.id) as FrameNode).children[0]!;
    useEditorStore.getState().select([gId]);
    useEditorStore.getState().ungroup();
    const st = useEditorStore.getState();
    expect(st.nodes[gId]).toBeUndefined();
    expect((node(seed.frame.id) as FrameNode).children).toEqual([
      seed.a.id,
      seed.b.id,
    ]);
    expect(st.selectedIds).toEqual([seed.a.id, seed.b.id]);
  });

  it("does nothing with an empty selection", () => {
    const s = useEditorStore.getState();
    s.clearSelection();
    const before = useEditorStore.getState().rootIds;
    s.group();
    expect(useEditorStore.getState().rootIds).toBe(before);
  });
});

describe("document status / save", () => {
  it("markSaved sets saved; a later edit flips back to edited", () => {
    expect(useEditorStore.getState().docStatus).toBe("draft");
    useEditorStore.getState().markSaved();
    expect(useEditorStore.getState().docStatus).toBe("saved");
    useEditorStore.getState().updateNode(seed.a.id, { x: 5 });
    expect(useEditorStore.getState().docStatus).toBe("edited");
  });

  it("loads a restored scene as saved", () => {
    useEditorStore.getState().loadScene({
      rootIds: [seed.c.id],
      nodes: { [seed.c.id]: seed.c },
      docName: "Restored",
      sourceId: "/caps/x.png",
      status: "saved",
    });
    expect(useEditorStore.getState().docStatus).toBe("saved");
  });
});

describe("inspector chrome", () => {
  const st = () => useEditorStore.getState();

  it("treats an unlisted section as open and toggles it closed", () => {
    expect(st().sectionsOpen.fill).toBeUndefined();
    st().toggleSection("fill");
    expect(st().sectionsOpen.fill).toBe(false);
    st().toggleSection("fill");
    expect(st().sectionsOpen.fill).toBe(true);
  });

  it("starts Stroke and Effects collapsed", () => {
    expect(st().sectionsOpen.stroke).toBe(false);
    expect(st().sectionsOpen.effects).toBe(false);
  });

  it("force-opens a section so an added row isn't created out of sight", () => {
    st().setSectionOpen("effects", true);
    expect(st().sectionsOpen.effects).toBe(true);
    // Idempotent — setting the value it already has is a no-op.
    const before = st().sectionsOpen;
    st().setSectionOpen("effects", true);
    expect(st().sectionsOpen).toBe(before);
  });

  it("clamps the inspector width to its bounds", () => {
    st().setPanelWidth(10_000);
    expect(st().panelWidth).toBe(PANEL_WIDTH_MAX);
    st().setPanelWidth(0);
    expect(st().panelWidth).toBe(PANEL_WIDTH_MIN);
    st().setPanelWidth(300);
    expect(st().panelWidth).toBe(300);
  });
});

describe("crop session", () => {
  const st = () => useEditorStore.getState();

  /** Load a page-shaped document (one root frame + its photo), which is what
   *  `sceneFromImage` builds and the only shape crop operates on. */
  function loadPage(): FrameNode {
    __resetNodeIdForTests();
    const page = makeFrame(
      { x: 0, y: 0, width: 400, height: 300 },
      { name: "Page" }
    );
    const photo = makeRectangle(
      { x: 0, y: 0, width: 400, height: 300 },
      { name: "Photo" }
    );
    page.children = [photo.id];
    st().loadScene({
      rootIds: [page.id],
      nodes: { [page.id]: page, [photo.id]: photo },
      docName: "Page",
      sourceId: null,
    });
    return page;
  }

  it("opens on the page frame, clearing the selection", () => {
    const page = loadPage();
    st().select([page.id]);
    st().beginCrop();
    const s = st();
    expect(s.tool).toBe("crop");
    expect(s.selectedIds).toEqual([]);
    expect(s.cropSession).toEqual({
      nodeId: page.id,
      rect: { x: 0, y: 0, width: 400, height: 300 },
      original: { x: 0, y: 0, width: 400, height: 300 },
      aspect: null,
    });
  });

  it("stays inert when the backmost root isn't a frame", () => {
    __resetNodeIdForTests();
    const loose = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    st().loadScene({
      rootIds: [loose.id],
      nodes: { [loose.id]: loose },
      docName: "Flat",
      sourceId: null,
    });
    st().setTool("rectangle");
    st().beginCrop();
    expect(st().cropSession).toBeNull();
    // The active tool is left alone rather than switching to an inert mode.
    expect(st().tool).toBe("rectangle");
  });

  it("absorbs sibling-root annotations so the export follows the crop", () => {
    const page = loadPage();
    // Markup drawn past the image edge lives beside the page, not inside it.
    const note = makeRectangle(
      { x: 500, y: 0, width: 40, height: 40 },
      { name: "Note" }
    );
    st().addNode(note, null);
    expect(st().rootIds).toEqual([page.id, note.id]);

    st().beginCrop();
    st().setCropRect({ x: 0, y: 0, width: 200, height: 150 });
    st().commitCrop();

    // One root — so `unionBounds` (the export + fit region) is the crop rect.
    expect(st().rootIds).toEqual([page.id]);
    const children = (node(page.id) as FrameNode).children;
    expect(children[children.length - 1]).toBe(note.id);
    // …and the page clips, so the live canvas shows the same trim.
    expect(node(page.id)).toMatchObject({
      clipContent: true,
      width: 200,
      height: 150,
    });

    // Still one undo step, restoring both the rect and the tree.
    st().undo();
    expect(st().rootIds).toEqual([page.id, note.id]);
    expect(node(page.id)).toMatchObject({ width: 400, height: 300 });
  });

  it("leaves the tree alone when the crop doesn't move", () => {
    const page = loadPage();
    const note = makeRectangle({ x: 500, y: 0, width: 40, height: 40 });
    st().addNode(note, null);
    st().beginCrop();
    st().commitCrop();
    // No crop means no restructure — applying an untouched session is inert.
    expect(st().rootIds).toEqual([page.id, note.id]);
  });

  it("applies the pending rect to the page as one undo step", () => {
    const page = loadPage();
    const before = st().past.length;
    st().beginCrop();
    st().setCropRect({ x: 20, y: 30, width: 200, height: 150 });
    st().commitCrop();

    expect(node(page.id)).toMatchObject({
      x: 20,
      y: 30,
      width: 200,
      height: 150,
    });
    expect(st().past).toHaveLength(before + 1);
    expect(st().cropSession).toBeNull();
    expect(st().tool).toBe("select");
    // The cropped page is selected so its new bounds are visible.
    expect(st().selectedIds).toEqual([page.id]);

    st().undo();
    expect(node(page.id)).toMatchObject({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });

  it("rounds a fractional drag to whole scene pixels on commit", () => {
    const page = loadPage();
    st().beginCrop();
    st().setCropRect({ x: 10.4, y: 20.6, width: 100.3, height: 50.2 });
    st().commitCrop();
    expect(node(page.id)).toMatchObject({
      x: 10,
      y: 21,
      width: 101,
      height: 50,
    });
  });

  it("keeps the page's children in place — crop discards no pixels", () => {
    const page = loadPage();
    const photoId = (node(page.id) as FrameNode).children[0]!;
    const before = node(photoId);
    st().beginCrop();
    st().setCropRect({ x: 50, y: 50, width: 100, height: 100 });
    st().commitCrop();
    // The bitmap keeps its absolute coords; the frame's clip does the trimming.
    expect(node(photoId)).toMatchObject({
      x: before.x,
      y: before.y,
      width: before.width,
      height: before.height,
    });
  });

  it("records no history when the crop doesn't move", () => {
    loadPage();
    const before = st().past.length;
    st().beginCrop();
    st().commitCrop();
    expect(st().past).toHaveLength(before);
  });

  it("cancels without touching the document", () => {
    const page = loadPage();
    const before = st().past.length;
    st().beginCrop();
    st().setCropRect({ x: 1, y: 2, width: 3, height: 4 });
    st().cancelCrop();
    expect(st().cropSession).toBeNull();
    expect(st().tool).toBe("select");
    expect(st().past).toHaveLength(before);
    expect(node(page.id)).toMatchObject({
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
  });

  it("discards the session when another tool is picked", () => {
    loadPage();
    st().beginCrop();
    st().setTool("rectangle");
    expect(st().cropSession).toBeNull();
  });

  it("re-entering crop keeps the open session rather than restarting it", () => {
    loadPage();
    st().beginCrop();
    st().setCropRect({ x: 5, y: 5, width: 50, height: 50 });
    st().setTool("crop");
    expect(st().cropSession?.rect).toEqual({
      x: 5,
      y: 5,
      width: 50,
      height: 50,
    });
  });

  it("re-fits the pending rect when an aspect is locked, and frees it again", () => {
    loadPage();
    st().beginCrop();
    st().setCropAspect(1);
    const locked = st().cropSession!;
    expect(locked.aspect).toBe(1);
    expect(locked.rect.width).toBeCloseTo(300);
    expect(locked.rect.height).toBeCloseTo(300);
    // Centred on the page.
    expect(locked.rect.x + locked.rect.width / 2).toBeCloseTo(200);

    st().setCropAspect(null);
    // Unlocking frees the ratio but leaves the framing the user can see.
    expect(st().cropSession!.aspect).toBeNull();
    expect(st().cropSession!.rect).toEqual(locked.rect);
  });

  it("resets to the page rect the session opened with", () => {
    loadPage();
    st().beginCrop();
    st().setCropRect({ x: 10, y: 10, width: 20, height: 20 });
    st().setCropAspect(16 / 9);
    st().resetCrop();
    const s = st().cropSession!;
    expect(s.rect).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(s.aspect).toBeNull();
  });

  it("ignores crop edits when no session is open", () => {
    loadPage();
    const before = st();
    st().setCropRect({ x: 1, y: 1, width: 1, height: 1 });
    st().setCropAspect(1);
    st().resetCrop();
    st().commitCrop();
    st().cancelCrop();
    expect(st().cropSession).toBeNull();
    expect(st().past).toHaveLength(before.past.length);
  });

  it("is cleared by loading a new document", () => {
    loadPage();
    st().beginCrop();
    loadPage();
    expect(st().cropSession).toBeNull();
  });
});
