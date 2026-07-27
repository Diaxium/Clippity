import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { __resetNodeIdForTests, makeRectangle } from "../types";
import { useEditorStore } from "../state/editorStore";
import { ColorPopover } from "./ColorPopover";

afterEach(cleanup);

function loadRect() {
  __resetNodeIdForTests();
  const r = makeRectangle({ x: 0, y: 0, width: 50, height: 50 });
  useEditorStore.getState().loadScene({
    rootIds: [r.id],
    nodes: { [r.id]: r },
    docName: "T",
    sourceId: null,
  });
  useEditorStore.getState().select([r.id]);
  return r;
}

describe("ColorPopover", () => {
  it("renders nothing when no color editor is open", () => {
    loadRect();
    useEditorStore.getState().closeColorEditor();
    const { container } = render(<ColorPopover />);
    expect(container).toBeEmptyDOMElement();
  });

  it("hosts the fill editor when opened, and closes via the X", () => {
    const r = loadRect();
    const fillId = r.fills[0]!.id;
    useEditorStore
      .getState()
      .openColorEditor({ kind: "fill", nodeId: r.id, fillId }, 100, 100);
    render(<ColorPopover />);
    expect(screen.getByText("Fill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gradient" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Close color editor"));
    expect(useEditorStore.getState().colorEditor).toBeNull();
  });

  it("pressing the X never starts a header drag that would swallow the close", () => {
    const r = loadRect();
    const fillId = r.fills[0]!.id;
    useEditorStore
      .getState()
      .openColorEditor({ kind: "fill", nodeId: r.id, fillId }, 100, 100);
    render(<ColorPopover />);
    const x = screen.getByLabelText("Close color editor");
    const header = x.parentElement as HTMLElement;
    // jsdom has no pointer capture; a spy makes a stray drag-start observable.
    // In a real browser capturing here retargets the click to the header and
    // the X looks dead, so the press must never reach setPointerCapture.
    const capture = vi.fn();
    (header as unknown as { setPointerCapture: typeof capture }).setPointerCapture =
      capture;
    fireEvent.pointerDown(x);
    expect(capture).not.toHaveBeenCalled();
    fireEvent.click(x);
    expect(useEditorStore.getState().colorEditor).toBeNull();
  });

  it("re-clamps back into view when the menu grows past the bottom edge", () => {
    // Local alias for the DOM-global callback signature — `ResizeObserverCallback`
    // isn't a runtime global, so ESLint's `no-undef` rejects it (same pattern as
    // `useToastResize.test.ts`).
    type ROCallback = (
      entries: ResizeObserverEntry[],
      observer: ResizeObserver
    ) => void;
    const origRO = globalThis.ResizeObserver;
    const origIH = window.innerHeight;
    let roCb: ROCallback | null = null;
    class MockRO {
      constructor(cb: ROCallback) {
        roCb = cb;
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = MockRO as unknown as typeof ResizeObserver;
    Object.defineProperty(window, "innerHeight", {
      value: 600,
      configurable: true,
    });
    try {
      const r = loadRect();
      const fillId = r.fills[0]!.id;
      // Anchor low on the screen.
      useEditorStore
        .getState()
        .openColorEditor({ kind: "fill", nodeId: r.id, fillId }, 800, 420);
      render(<ColorPopover />);
      const root = screen
        .getByLabelText("Close color editor")
        .closest("div.fixed") as HTMLElement;
      expect(root).toBeTruthy();
      // Capped to the viewport so an over-tall body scrolls rather than clips.
      expect(root.style.maxHeight).toBe("584px");
      // Opens centered (no canvas-area element under test → viewport center).
      const topOnOpen = parseInt(root.style.top, 10);
      expect(topOnOpen).toBeGreaterThan(92);

      // The fill grows tall (gradient + expanded picker). Drive the observer.
      root.getBoundingClientRect = () =>
        ({ height: 500, width: 248 }) as DOMRect;
      act(() => {
        roCb?.([] as unknown as ResizeObserverEntry[], {} as ResizeObserver);
      });

      // A 500-tall menu must be pulled fully into the 600 viewport:
      // 8 ≤ top ≤ 600 - 500 - 8 = 92.
      const topGrown = parseInt(root.style.top, 10);
      expect(topGrown).toBeGreaterThanOrEqual(8);
      expect(topGrown).toBeLessThanOrEqual(92);
    } finally {
      globalThis.ResizeObserver = origRO;
      Object.defineProperty(window, "innerHeight", {
        value: origIH,
        configurable: true,
      });
    }
  });

  it("hosts a solid color picker for a stroke target", () => {
    const r = loadRect();
    useEditorStore.getState().addStroke(r.id);
    const strokeId = useEditorStore.getState().nodes[r.id]!.strokes[0]!.id;
    useEditorStore
      .getState()
      .openColorEditor({ kind: "stroke", nodeId: r.id, strokeId }, 50, 50);
    render(<ColorPopover />);
    expect(screen.getByText("Stroke")).toBeInTheDocument();
    // Solid body — no fill-type tabs / blend header.
    expect(screen.queryByLabelText("Blend mode")).toBeNull();
  });

  // Workstream P3: the popover reads the primary target but writes to the
  // primary *plus* the peer rows the section resolved from the rest of the
  // selection — so a color edit paints everything selected, not just one node.
  describe("multi-select peers", () => {
    /** The picker's hex field — the only textbox holding a bare 6-digit hex
     *  (opacity and the blend header render numbers). */
    const hexField = (): HTMLElement =>
      screen
        .getAllByRole("textbox")
        .find((el) => /^[0-9A-F]{6}$/.test((el as HTMLInputElement).value))!;

    function loadTwoRects() {
      __resetNodeIdForTests();
      const a = makeRectangle({ x: 0, y: 0, width: 50, height: 50 });
      const b = makeRectangle({ x: 60, y: 0, width: 50, height: 50 });
      useEditorStore.getState().loadScene({
        rootIds: [a.id, b.id],
        nodes: { [a.id]: a, [b.id]: b },
        docName: "T",
        sourceId: null,
      });
      useEditorStore.getState().select([a.id, b.id]);
      return { a, b };
    }

    it("writes a fill edit to the peer as well as the primary", () => {
      const { a, b } = loadTwoRects();
      useEditorStore.getState().openColorEditor(
        { kind: "fill", nodeId: a.id, fillId: a.fills[0]!.id },
        10,
        10,
        [{ kind: "fill", nodeId: b.id, fillId: b.fills[0]!.id }]
      );
      render(<ColorPopover />);

      const hex = hexField();
      fireEvent.change(hex, { target: { value: "00FF00" } });
      fireEvent.blur(hex);

      const nodes = useEditorStore.getState().nodes;
      expect(nodes[a.id]!.fills[0]!.color).toBe("#00ff00");
      expect(nodes[b.id]!.fills[0]!.color).toBe("#00ff00");
    });

    it("lands the batch as a single undo step", () => {
      const { a, b } = loadTwoRects();
      const before = a.fills[0]!.color;
      useEditorStore.getState().openColorEditor(
        { kind: "fill", nodeId: a.id, fillId: a.fills[0]!.id },
        10,
        10,
        [{ kind: "fill", nodeId: b.id, fillId: b.fills[0]!.id }]
      );
      render(<ColorPopover />);

      const hex = hexField();
      fireEvent.change(hex, { target: { value: "123456" } });
      fireEvent.blur(hex);
      expect(useEditorStore.getState().nodes[b.id]!.fills[0]!.color).toBe(
        "#123456"
      );

      useEditorStore.getState().undo();
      const nodes = useEditorStore.getState().nodes;
      expect(nodes[a.id]!.fills[0]!.color).toBe(before);
      expect(nodes[b.id]!.fills[0]!.color).toBe(before);
    });

    it("still writes only the primary when there are no peers", () => {
      const { a, b } = loadTwoRects();
      useEditorStore
        .getState()
        .openColorEditor(
          { kind: "fill", nodeId: a.id, fillId: a.fills[0]!.id },
          10,
          10
        );
      render(<ColorPopover />);

      const hex = hexField();
      fireEvent.change(hex, { target: { value: "abcdef" } });
      fireEvent.blur(hex);

      const nodes = useEditorStore.getState().nodes;
      expect(nodes[a.id]!.fills[0]!.color).toBe("#abcdef");
      expect(nodes[b.id]!.fills[0]!.color).toBe(b.fills[0]!.color);
    });
  });
});
