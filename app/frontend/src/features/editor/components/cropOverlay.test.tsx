import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { useEditorStore } from "../state/editorStore";
import {
  __resetNodeIdForTests,
  makeFrame,
  makeRectangle,
  type FrameNode,
  type SceneNode,
} from "../types";
import { EditorCanvas } from "./EditorCanvas";

// Same jsdom shims as editorCanvas.test.tsx: no pointer capture, and
// PointerEvent carries no coordinates unless it's backed by MouseEvent.
interface PointerInit {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  button?: number;
  shiftKey?: boolean;
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

const state = () => useEditorStore.getState();

/** A page-shaped document: one root frame (the page) with a child bitmap. */
function seedPage(): FrameNode {
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
  const nodes: Record<string, SceneNode> = {
    [page.id]: page,
    [photo.id]: photo,
  };
  state().loadScene({
    rootIds: [page.id],
    nodes,
    docName: "Page",
    sourceId: null,
  });
  // Identity viewport, so client coords equal scene coords.
  return page;
}

afterEach(cleanup);

describe("CropOverlay", () => {
  it("stays hidden until a crop session opens", () => {
    seedPage();
    render(<EditorCanvas />);
    expect(screen.queryByTestId("crop-overlay")).toBeNull();
    act(() => state().beginCrop());
    expect(screen.getByTestId("crop-overlay")).toBeTruthy();
  });

  it("renders a drag target per edge and corner", () => {
    seedPage();
    render(<EditorCanvas />);
    act(() => state().beginCrop());
    const overlay = screen.getByTestId("crop-overlay");
    const handles = overlay.querySelectorAll("[data-crop]");
    expect(handles).toHaveLength(8);
    expect(overlay.querySelector('[data-crop="nw"]')).toBeTruthy();
    expect(overlay.querySelector('[data-crop="e"]')).toBeTruthy();
  });

  it("shows the live crop size and applies from the bar", () => {
    const page = seedPage();
    render(<EditorCanvas />);
    act(() => state().beginCrop());
    act(() => state().setCropRect({ x: 0, y: 0, width: 320, height: 180 }));

    expect(screen.getByLabelText("Crop size").textContent).toBe("320 × 180");
    fireEvent.click(screen.getByLabelText("Apply crop"));

    expect(state().cropSession).toBeNull();
    expect(state().nodes[page.id]).toMatchObject({ width: 320, height: 180 });
  });

  it("locks the ratio from an aspect chip", () => {
    seedPage();
    render(<EditorCanvas />);
    act(() => state().beginCrop());
    fireEvent.click(screen.getByText("1:1"));

    const rect = state().cropSession!.rect;
    expect(state().cropSession!.aspect).toBe(1);
    expect(rect.width).toBeCloseTo(rect.height);
    expect(screen.getByText("1:1").getAttribute("aria-pressed")).toBe("true");
  });

  it("cancels from the bar without touching the page", () => {
    const page = seedPage();
    render(<EditorCanvas />);
    act(() => state().beginCrop());
    act(() => state().setCropRect({ x: 10, y: 10, width: 50, height: 50 }));
    fireEvent.click(screen.getByLabelText("Cancel crop"));

    expect(state().cropSession).toBeNull();
    expect(state().nodes[page.id]).toMatchObject({ width: 400, height: 300 });
  });
});

describe("EditorCanvas crop gesture", () => {
  function down(el: Element, clientX: number, clientY: number): void {
    fireEvent.pointerDown(el, { clientX, clientY, button: 0, pointerId: 1 });
  }

  it("drags a handle to resize the crop window", () => {
    seedPage();
    const { container } = render(<EditorCanvas />);
    const host = container.firstElementChild!;
    act(() => state().beginCrop());

    const east = screen
      .getByTestId("crop-overlay")
      .querySelector('[data-crop="e"]')!;
    down(east, 400, 150);
    fireEvent.pointerMove(host, { clientX: 250, clientY: 150, pointerId: 1 });

    expect(state().activeGesture).toBe("crop");
    expect(state().cropSession!.rect).toEqual({
      x: 0,
      y: 0,
      width: 250,
      height: 300,
    });

    fireEvent.pointerUp(host, { clientX: 250, clientY: 150, pointerId: 1 });
    expect(state().activeGesture).toBeNull();
  });

  it("holds the ratio while Shift is down mid-drag", () => {
    seedPage();
    const { container } = render(<EditorCanvas />);
    const host = container.firstElementChild!;
    act(() => state().beginCrop());
    // Start from a square so the locked ratio is unambiguous.
    act(() => state().setCropRect({ x: 0, y: 0, width: 200, height: 200 }));

    const se = screen
      .getByTestId("crop-overlay")
      .querySelector('[data-crop="se"]')!;
    down(se, 200, 200);
    fireEvent.pointerMove(host, {
      clientX: 100,
      clientY: 180,
      pointerId: 1,
      shiftKey: true,
    });

    const rect = state().cropSession!.rect;
    expect(rect.width).toBeCloseTo(rect.height);
  });

  it("slides the whole window when the drag starts inside it", () => {
    seedPage();
    const { container } = render(<EditorCanvas />);
    const host = container.firstElementChild!;
    act(() => state().beginCrop());
    act(() => state().setCropRect({ x: 0, y: 0, width: 200, height: 200 }));

    down(host, 100, 100);
    fireEvent.pointerMove(host, { clientX: 130, clientY: 90, pointerId: 1 });

    expect(state().cropSession!.rect).toEqual({
      x: 30,
      y: -10,
      width: 200,
      height: 200,
    });
  });

  it("never picks or marquees while a session is open", () => {
    const page = seedPage();
    const { container } = render(<EditorCanvas />);
    const host = container.firstElementChild!;
    act(() => state().beginCrop());

    // A press well outside the crop window would normally start a marquee.
    down(host, 900, 900);
    fireEvent.pointerMove(host, { clientX: 950, clientY: 950, pointerId: 1 });
    fireEvent.pointerUp(host, { clientX: 950, clientY: 950, pointerId: 1 });

    expect(state().activeGesture).toBeNull();
    expect(state().selectedIds).toEqual([]);
    // And a double-click doesn't re-select the page underneath the dim.
    fireEvent.doubleClick(host, { clientX: 100, clientY: 100 });
    expect(state().selectedIds).toEqual([]);
    expect(state().nodes[page.id]).toMatchObject({ width: 400, height: 300 });
  });
});
