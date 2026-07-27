import { beforeEach, describe, expect, it } from "vitest";

import { useOverlayStore } from "./overlayStore";

const initial = useOverlayStore.getState();

describe("overlayStore", () => {
  beforeEach(() => {
    useOverlayStore.setState(initial, true);
  });

  it("defaults to region mode and empty phase", () => {
    const s = useOverlayStore.getState();
    expect(s.mode).toBe("region");
    expect(s.phase).toBe("empty");
    expect(s.rect).toBeNull();
    expect(s.cursor).toBeNull();
  });

  it("startDrag transitions empty → dragging and seeds start/cur", () => {
    useOverlayStore.getState().startDrag({ x: 10, y: 20 });
    const s = useOverlayStore.getState();
    expect(s.phase).toBe("dragging");
    expect(s.start).toEqual({ x: 10, y: 20 });
    expect(s.cur).toEqual({ x: 10, y: 20 });
    expect(s.cursor).toEqual({ x: 10, y: 20 });
    expect(s.rect).toBeNull();
  });

  it("updateDrag advances cur and cursor without leaving dragging", () => {
    useOverlayStore.getState().startDrag({ x: 0, y: 0 });
    useOverlayStore.getState().updateDrag({ x: 50, y: 30 });
    expect(useOverlayStore.getState().cur).toEqual({ x: 50, y: 30 });
    expect(useOverlayStore.getState().cursor).toEqual({ x: 50, y: 30 });
    expect(useOverlayStore.getState().phase).toBe("dragging");
  });

  it("endDrag with a valid rect → selected phase", () => {
    useOverlayStore.getState().startDrag({ x: 0, y: 0 });
    useOverlayStore.getState().endDrag({ x: 0, y: 0, w: 100, h: 50 });
    const s = useOverlayStore.getState();
    expect(s.phase).toBe("selected");
    expect(s.rect).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(s.start).toBeNull();
  });

  it("endDrag with null rect → idle (rejected drag)", () => {
    useOverlayStore.getState().startDrag({ x: 0, y: 0 });
    useOverlayStore.getState().endDrag(null);
    const s = useOverlayStore.getState();
    expect(s.phase).toBe("idle");
    expect(s.rect).toBeNull();
  });

  it("setToggles merges partial updates", () => {
    useOverlayStore.getState().setToggles({ cursor: true });
    expect(useOverlayStore.getState().toggles).toEqual({
      preview: true,
      clipboard: false,
      cursor: true,
      enhance: false,
    });
  });

  it("reset returns to empty phase + clears selection + help", () => {
    useOverlayStore.getState().startDrag({ x: 5, y: 5 });
    useOverlayStore.getState().endDrag({ x: 0, y: 0, w: 100, h: 100 });
    useOverlayStore.getState().setHelpOpen(true);
    useOverlayStore.getState().setSnapshot({
      url: "data:image/png;base64,old",
      sampleCtx: {} as CanvasRenderingContext2D,
    });

    useOverlayStore.getState().reset();

    const s = useOverlayStore.getState();
    expect(s.phase).toBe("empty");
    expect(s.rect).toBeNull();
    expect(s.helpOpen).toBe(false);
    expect(s.cursor).toBeNull();
    expect(s.snapshot).toEqual({ url: null, sampleCtx: null });
  });

  it("reset can seed the opening cursor and enter idle", () => {
    useOverlayStore.getState().endDrag({ x: 0, y: 0, w: 100, h: 100 });
    useOverlayStore.getState().reset({ x: 12, y: 34 });

    const s = useOverlayStore.getState();
    expect(s.phase).toBe("idle");
    expect(s.rect).toBeNull();
    expect(s.cursor).toEqual({ x: 12, y: 34 });
  });

  it("setSnapshot caches the data URI + sample context", () => {
    const fakeCtx = {} as CanvasRenderingContext2D;
    useOverlayStore.getState().setSnapshot({
      url: "data:image/png;base64,abc",
      sampleCtx: fakeCtx,
    });
    expect(useOverlayStore.getState().snapshot.url).toBe(
      "data:image/png;base64,abc"
    );
    expect(useOverlayStore.getState().snapshot.sampleCtx).toBe(fakeCtx);
  });

  it("defaults to an empty window list with no hover", () => {
    const s = useOverlayStore.getState();
    expect(s.windows).toEqual([]);
    expect(s.hoveredWindowId).toBeNull();
  });

  it("setWindows + setHoveredWindow update the window slice", () => {
    const windows = [
      {
        id: 1,
        title: "A",
        app: "",
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
    ];
    useOverlayStore.getState().setWindows(windows);
    useOverlayStore.getState().setHoveredWindow(1);
    expect(useOverlayStore.getState().windows).toEqual(windows);
    expect(useOverlayStore.getState().hoveredWindowId).toBe(1);
  });

  it("reset clears the hovered window but leaves the list (hook-owned)", () => {
    useOverlayStore.getState().setWindows([
      {
        id: 1,
        title: "A",
        app: "",
        rect: { x: 0, y: 0, width: 10, height: 10 },
      },
    ]);
    useOverlayStore.getState().setHoveredWindow(1);
    useOverlayStore.getState().reset();
    expect(useOverlayStore.getState().hoveredWindowId).toBeNull();
    expect(useOverlayStore.getState().windows).toHaveLength(1);
  });

  it("beginFreehand seeds the path and enters dragging", () => {
    useOverlayStore.getState().beginFreehand({ x: 10, y: 20 });
    const s = useOverlayStore.getState();
    expect(s.freehandPath).toEqual([{ x: 10, y: 20 }]);
    expect(s.phase).toBe("dragging");
    expect(s.cursor).toEqual({ x: 10, y: 20 });
  });

  it("extendFreehand appends path points", () => {
    const st = useOverlayStore.getState();
    st.beginFreehand({ x: 0, y: 0 });
    st.extendFreehand({ x: 5, y: 5 });
    st.extendFreehand({ x: 10, y: 0 });
    expect(useOverlayStore.getState().freehandPath).toHaveLength(3);
  });

  it("endFreehand(true) selects; endFreehand(false) clears the path", () => {
    const st = useOverlayStore.getState();
    st.beginFreehand({ x: 0, y: 0 });
    st.extendFreehand({ x: 10, y: 0 });
    st.extendFreehand({ x: 5, y: 10 });
    st.endFreehand(true);
    expect(useOverlayStore.getState().phase).toBe("selected");
    expect(useOverlayStore.getState().freehandPath).toHaveLength(3);

    st.beginFreehand({ x: 0, y: 0 });
    st.endFreehand(false);
    expect(useOverlayStore.getState().phase).not.toBe("selected");
    expect(useOverlayStore.getState().freehandPath).toEqual([]);
  });

  it("commitArea appends + selects; popArea removes the last", () => {
    const st = useOverlayStore.getState();
    st.commitArea({ x: 0, y: 0, w: 10, h: 10 });
    st.commitArea({ x: 20, y: 0, w: 10, h: 10 });
    expect(useOverlayStore.getState().areas).toHaveLength(2);
    expect(useOverlayStore.getState().phase).toBe("selected");
    st.popArea();
    expect(useOverlayStore.getState().areas).toHaveLength(1);
    st.popArea();
    expect(useOverlayStore.getState().areas).toEqual([]);
  });

  it("reset clears the freehand path + committed areas", () => {
    const st = useOverlayStore.getState();
    st.beginFreehand({ x: 1, y: 1 });
    st.commitArea({ x: 0, y: 0, w: 5, h: 5 });
    st.reset();
    expect(useOverlayStore.getState().freehandPath).toEqual([]);
    expect(useOverlayStore.getState().areas).toEqual([]);
  });

  it("addPenAnchor appends anchors and enters dragging", () => {
    const st = useOverlayStore.getState();
    st.addPenAnchor({ p: { x: 1, y: 1 }, hIn: null, hOut: null });
    st.addPenAnchor({ p: { x: 9, y: 1 }, hIn: null, hOut: null });
    const s = useOverlayStore.getState();
    expect(s.penPath).toHaveLength(2);
    expect(s.phase).toBe("dragging");
    expect(s.cursorPin).toEqual({ x: 9, y: 1 });
  });

  it("updatePenHandles edits the last anchor in place", () => {
    const st = useOverlayStore.getState();
    st.addPenAnchor({ p: { x: 5, y: 5 }, hIn: null, hOut: null });
    st.updatePenHandles({ x: 0, y: 5 }, { x: 10, y: 5 });
    const last = useOverlayStore.getState().penPath.at(-1)!;
    expect(last.hIn).toEqual({ x: 0, y: 5 });
    expect(last.hOut).toEqual({ x: 10, y: 5 });
  });

  it("closePen only commits with ≥ 3 anchors", () => {
    const st = useOverlayStore.getState();
    st.addPenAnchor({ p: { x: 0, y: 0 }, hIn: null, hOut: null });
    st.addPenAnchor({ p: { x: 9, y: 0 }, hIn: null, hOut: null });
    st.closePen();
    expect(useOverlayStore.getState().phase).toBe("dragging"); // only 2
    st.addPenAnchor({ p: { x: 9, y: 9 }, hIn: null, hOut: null });
    st.closePen();
    expect(useOverlayStore.getState().phase).toBe("selected");
  });

  it("popPenAnchor removes the last anchor and falls back to idle/empty", () => {
    const st = useOverlayStore.getState();
    st.setCursor({ x: 2, y: 2 }); // gives an idle fallback
    st.addPenAnchor({ p: { x: 0, y: 0 }, hIn: null, hOut: null });
    st.popPenAnchor();
    const s = useOverlayStore.getState();
    expect(s.penPath).toEqual([]);
    expect(s.phase).toBe("idle");
  });

  it("clearSelection drops the selection but preserves the snapshot", () => {
    const st = useOverlayStore.getState();
    const fakeCtx = {} as CanvasRenderingContext2D;
    st.setSnapshot({ url: "data:image/png;base64,xx", sampleCtx: fakeCtx });
    st.addPenAnchor({ p: { x: 1, y: 1 }, hIn: null, hOut: null });
    st.beginFreehand({ x: 2, y: 2 });
    st.clearSelection();
    const s = useOverlayStore.getState();
    expect(s.penPath).toEqual([]);
    expect(s.freehandPath).toEqual([]);
    expect(s.rect).toBeNull();
    expect(s.phase).toBe("idle"); // cursor present → idle, not empty
    // Snapshot + cursor survive the in-place method switch (cursor is the
    // last tracked position — beginFreehand moved it to {2,2}).
    expect(s.snapshot.url).toBe("data:image/png;base64,xx");
    expect(s.snapshot.sampleCtx).toBe(fakeCtx);
    expect(s.cursor).toEqual({ x: 2, y: 2 });
  });

  it("setBrushSize clamps to the supported range", () => {
    const st = useOverlayStore.getState();
    st.setBrushSize(0);
    expect(useOverlayStore.getState().brushSize).toBe(2);
    st.setBrushSize(9999);
    expect(useOverlayStore.getState().brushSize).toBe(300);
    st.setBrushSize(48.6);
    expect(useOverlayStore.getState().brushSize).toBe(49);
  });

  it("bumpBrush advances the render version and enters dragging", () => {
    const st = useOverlayStore.getState();
    const v0 = useOverlayStore.getState().brushVersion;
    st.bumpBrush();
    const s = useOverlayStore.getState();
    expect(s.brushVersion).toBe(v0 + 1);
    expect(s.phase).toBe("dragging");
  });

  it("commitBrush moves to selected with ink, idle without", () => {
    const st = useOverlayStore.getState();
    st.commitBrush(true);
    expect(useOverlayStore.getState().phase).toBe("selected");
    expect(useOverlayStore.getState().brushHasInk).toBe(true);
    st.setCursor({ x: 1, y: 1 });
    st.commitBrush(false);
    expect(useOverlayStore.getState().phase).toBe("idle");
    expect(useOverlayStore.getState().brushHasInk).toBe(false);
  });

  it("clearBrush drops ink and bumps the version", () => {
    const st = useOverlayStore.getState();
    st.setBrushMode("subtract");
    st.commitBrush(true);
    const v0 = useOverlayStore.getState().brushVersion;
    st.clearBrush();
    const s = useOverlayStore.getState();
    expect(s.brushHasInk).toBe(false);
    expect(s.brushVersion).toBe(v0 + 1);
    // The mode preference is independent of clearing the painting.
    expect(s.brushMode).toBe("subtract");
  });

  // ── last region ("capture that same spot again") ──────────────────

  const LAST = { x: 100, y: 120, w: 400, h: 300 };
  const identity = (r: typeof LAST) => r;

  it("restoreLastRegion drops the remembered rect in as a committed selection", () => {
    const st = useOverlayStore.getState();
    st.setLastRegion(LAST);
    st.restoreLastRegion(identity);

    const s = useOverlayStore.getState();
    // `selected` (not `idle`) is what makes Capture/Enter live immediately.
    expect(s.phase).toBe("selected");
    expect(s.rect).toEqual(LAST);
  });

  it("restoreLastRegion is a no-op when nothing is remembered", () => {
    const st = useOverlayStore.getState();
    st.restoreLastRegion(identity);

    const s = useOverlayStore.getState();
    expect(s.rect).toBeNull();
    expect(s.phase).toBe("empty");
  });

  it("restoreLastRegion applies the caller's clamp", () => {
    const st = useOverlayStore.getState();
    st.setLastRegion(LAST);
    st.restoreLastRegion((r) => ({ ...r, w: 50 }));
    expect(useOverlayStore.getState().rect).toEqual({ ...LAST, w: 50 });
  });

  it("restoreLastRegion abandons an in-progress drag", () => {
    const st = useOverlayStore.getState();
    st.setLastRegion(LAST);
    st.startDrag({ x: 5, y: 5 });
    st.updateDrag({ x: 60, y: 60 });
    st.restoreLastRegion(identity);

    const s = useOverlayStore.getState();
    // A stale start/cur would keep RegionSelection rendering the drag
    // preview on top of the restored rect.
    expect(s.start).toBeNull();
    expect(s.cur).toBeNull();
    expect(s.rect).toEqual(LAST);
  });

  it("reset keeps the remembered region (it outlives the selection)", () => {
    const st = useOverlayStore.getState();
    st.setLastRegion(LAST);
    st.reset();
    expect(useOverlayStore.getState().lastRegion).toEqual(LAST);
  });
});
