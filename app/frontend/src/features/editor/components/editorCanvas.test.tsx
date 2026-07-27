import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { useEditorStore } from "../state/editorStore";
import {
  __resetNodeIdForTests,
  makeRectangle,
  type PathNode,
  type RectangleNode,
  type SceneNode,
} from "../types";
import { EditorCanvas } from "./EditorCanvas";
// jsdom has no pointer-capture and no coordinate-carrying PointerEvent, both of
// which the canvas relies on. Back PointerEvent with MouseEvent so clientX/Y,
// button, and modifier keys reach the React handlers. `PointerInit` is a local
// structural subset of MouseEventInit (no DOM lib type name to trip no-undef).
interface PointerInit {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  button?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}
beforeAll(() => {
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, props: PointerInit = {}) {
      super(type, props);
      this.pointerId = props.pointerId ?? 1;
    }
  }
  globalThis.PointerEvent =
    PointerEventPolyfill as unknown as typeof PointerEvent;
});

interface Seed {
  a: RectangleNode;
  b: RectangleNode;
}

function seed(): Seed {
  __resetNodeIdForTests();
  // A at the origin, B a clear 200px gap to the right — both 100×100.
  const a = makeRectangle(
    { x: 0, y: 0, width: 100, height: 100 },
    { name: "A" }
  );
  const b = makeRectangle(
    { x: 300, y: 0, width: 100, height: 100 },
    { name: "B" }
  );
  const nodes: Record<string, SceneNode> = { [a.id]: a, [b.id]: b };
  useEditorStore
    .getState()
    .loadScene({ rootIds: [a.id, b.id], nodes, docName: "T", sourceId: null });
  // Default viewport is identity (zoom 1, pan 0), so client coords == scene.
  return { a, b };
}

const state = () => useEditorStore.getState();

afterEach(cleanup);

describe("EditorCanvas move gesture", () => {
  it("snaps a dragged node to a peer edge and shows then clears guides", () => {
    const { a, b } = seed();
    state().select([a.id]);
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    // Grab A at its center, drag so its right edge lands ~2px shy of B's left
    // edge (300). Snapping should pull it exactly onto 300 (→ A.x = 200).
    fireEvent.pointerDown(host, {
      clientX: 50,
      clientY: 50,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(host, { clientX: 252, clientY: 50, pointerId: 1 });

    expect(state().nodes[a.id]!.x).toBe(200);
    expect(state().nodes[a.id]!.y).toBe(0);
    expect(state().nodes[b.id]!.x).toBe(300); // peer untouched
    expect(state().guides.length).toBeGreaterThan(0);
    expect(state().activeGesture).toBe("move");

    fireEvent.pointerUp(host, { clientX: 252, clientY: 50, pointerId: 1 });
    expect(state().guides).toHaveLength(0);
    expect(state().transformHud).toBeNull();
    expect(state().activeGesture).toBeNull();
  });

  it("Cmd/Ctrl bypasses snapping for free placement", () => {
    const { a } = seed();
    state().select([a.id]);
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    fireEvent.pointerDown(host, {
      clientX: 50,
      clientY: 50,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(host, {
      clientX: 252,
      clientY: 50,
      ctrlKey: true,
      pointerId: 1,
    });

    // No snap → exact raw delta of +202.
    expect(state().nodes[a.id]!.x).toBe(202);
    expect(state().guides).toHaveLength(0);
  });

  it("Shift constrains the drag to the dominant axis", () => {
    const { a } = seed();
    state().select([a.id]);
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    fireEvent.pointerDown(host, {
      clientX: 50,
      clientY: 50,
      button: 0,
      pointerId: 1,
    });
    // Mostly-horizontal drag with Ctrl (skip snap) → vertical delta is zeroed.
    fireEvent.pointerMove(host, {
      clientX: 170,
      clientY: 70,
      shiftKey: true,
      ctrlKey: true,
      pointerId: 1,
    });

    expect(state().nodes[a.id]!.x).toBe(120);
    expect(state().nodes[a.id]!.y).toBe(0);
  });

  it("Alt-drag duplicates in place and moves the clone, leaving the original", () => {
    const { a, b } = seed();
    state().select([a.id]);
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    fireEvent.pointerDown(host, {
      clientX: 50,
      clientY: 50,
      button: 0,
      pointerId: 1,
      altKey: true,
    });
    fireEvent.pointerMove(host, {
      clientX: 180,
      clientY: 50,
      altKey: true,
      ctrlKey: true,
      pointerId: 1,
    });

    const sel = state().selectedIds;
    expect(sel).toHaveLength(1);
    expect(sel[0]).not.toBe(a.id);
    expect(state().nodes[a.id]!.x).toBe(0); // original stays put
    expect(state().rootIds).toHaveLength(3); // A, clone, B
    expect(state().nodes[b.id]!.x).toBe(300);

    fireEvent.pointerUp(host, { clientX: 180, clientY: 50, pointerId: 1 });
    // One undo removes the whole alt-drag (duplicate + move) in a single step.
    act(() => state().undo());
    expect(state().rootIds).toHaveLength(2);
  });
});

describe("EditorCanvas pen + pencil", () => {
  const pathNode = (): PathNode | undefined =>
    state()
      .rootIds.map((id) => state().nodes[id])
      .find((n): n is PathNode => n?.type === "path");

  it("pencil drag captures a freehand path", () => {
    seed();
    state().setTool("pencil");
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    fireEvent.pointerDown(host, {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(host, { clientX: 60, clientY: 60, pointerId: 1 });
    fireEvent.pointerMove(host, { clientX: 110, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(host, { clientX: 110, clientY: 10, pointerId: 1 });

    const node = pathNode();
    expect(node).toBeTruthy();
    expect(node!.points.length).toBeGreaterThanOrEqual(3);
    expect(node!.closed).toBe(false);
  });

  it("measure drags out a dimension line, not a box", () => {
    // A dimension *is* a line node, so the draft keeps signed width/height (the
    // a→b vector) instead of being normalized into a box — that is what makes
    // its endpoints the two points being measured.
    seed();
    state().setTool("measure");
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    fireEvent.pointerDown(host, {
      clientX: 500,
      clientY: 400,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(host, { clientX: 300, clientY: 460, pointerId: 1 });
    fireEvent.pointerUp(host, { clientX: 300, clientY: 460, pointerId: 1 });

    const line = state()
      .rootIds.map((id) => state().nodes[id])
      .find((n) => n?.measure);
    expect(line?.type).toBe("line");
    expect(line).toMatchObject({ x: 500, y: 400, width: -200, height: 60 });
    expect(line?.measure).toEqual({ caps: "tick", scale: 1, unit: "px" });
    // Drawing returns to Select, like every other drawing tool.
    expect(state().tool).toBe("select");
  });

  it("Shift snaps a dimension's aim to 45°", () => {
    seed();
    state().setTool("measure");
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    fireEvent.pointerDown(host, {
      clientX: 100,
      clientY: 100,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerMove(host, {
      clientX: 300,
      clientY: 120,
      shiftKey: true,
      pointerId: 1,
    });
    fireEvent.pointerUp(host, { clientX: 300, clientY: 120, pointerId: 1 });

    const line = state()
      .rootIds.map((id) => state().nodes[id])
      .find((n) => n?.measure)!;
    expect(line.height).toBeCloseTo(0); // a shallow drag flattens to horizontal
    expect(line.width).toBeCloseTo(Math.hypot(200, 20));
  });

  it("pen clicks build anchors; double-click finishes the path", () => {
    seed();
    state().setTool("pen");
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    fireEvent.pointerDown(host, {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(host, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerDown(host, {
      clientX: 90,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(host, { clientX: 90, clientY: 10, pointerId: 1 });
    expect(state().pen?.points).toHaveLength(2);

    fireEvent.doubleClick(host, { clientX: 90, clientY: 10 });
    expect(state().pen).toBeNull();
    expect(pathNode()).toBeTruthy();
  });

  it("Escape cancels an open pen path without creating a node", () => {
    seed();
    state().setTool("pen");
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;

    fireEvent.pointerDown(host, {
      clientX: 10,
      clientY: 10,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(host, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(state().pen).not.toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(state().pen).toBeNull();
    expect(pathNode()).toBeUndefined();
  });
});

describe("EditorCanvas callout tail gesture", () => {
  it("dragging the tail handle swings the tail as one undo step", () => {
    const { a } = seed();
    // A callout on A, tail straight down (tip at 50,140 in scene space).
    state().updateNode(a.id, { callout: { angle: 180, length: 40 } });
    state().select([a.id]);
    const pastBefore = state().past.length;

    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;
    const handle = container.querySelector('[data-callout="tail"]')!;
    expect(handle).not.toBeNull();

    // Press the tip handle, then drag to the right of the body center. The tail
    // should re-aim right (90°) with the reach past the right edge (150−100).
    fireEvent.pointerDown(handle, {
      clientX: 50,
      clientY: 140,
      button: 0,
      pointerId: 1,
    });
    expect(state().activeGesture).toBe("tail");
    fireEvent.pointerMove(host, { clientX: 150, clientY: 50, pointerId: 1 });

    const mid = state().nodes[a.id]!.callout!;
    expect(mid.angle).toBeCloseTo(90, 3);
    expect(mid.length).toBeCloseTo(50, 3);

    fireEvent.pointerUp(host, { clientX: 150, clientY: 50, pointerId: 1 });
    expect(state().activeGesture).toBeNull();
    expect(state().transformHud).toBeNull();
    // Exactly one history entry for the whole drag; undo restores the aim.
    expect(state().past.length).toBe(pastBefore + 1);
    state().undo();
    expect(state().nodes[a.id]!.callout).toEqual({ angle: 180, length: 40 });
  });

  it("Shift snaps the tail aim to 15° increments", () => {
    const { a } = seed();
    state().updateNode(a.id, { callout: { angle: 180, length: 40 } });
    state().select([a.id]);
    const { container } = render(<EditorCanvas />);
    const host = container.firstChild as HTMLElement;
    const handle = container.querySelector('[data-callout="tail"]')!;

    fireEvent.pointerDown(handle, {
      clientX: 50,
      clientY: 140,
      button: 0,
      pointerId: 1,
    });
    // Aim ~100° (down-right); Shift should snap to 105.
    fireEvent.pointerMove(host, {
      clientX: 150,
      clientY: 68,
      shiftKey: true,
      pointerId: 1,
    });
    expect(state().nodes[a.id]!.callout!.angle % 15).toBe(0);
    fireEvent.pointerUp(host, { clientX: 150, clientY: 68, pointerId: 1 });
  });
});
