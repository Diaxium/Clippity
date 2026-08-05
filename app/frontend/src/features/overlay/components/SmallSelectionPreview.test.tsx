import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useOverlayStore } from "../state/overlayStore";
import type { Rect } from "../types";
import {
  SmallSelectionPreview,
  isTinySelection,
  place,
} from "./SmallSelectionPreview";

/** Minimal snapshot stub — the component only reads `sampleCtx.canvas.{width,
 *  height}` and uses `dataUri` as a CSS background, so a real canvas context
 *  (which jsdom doesn't provide) isn't needed. */
function seedSnapshot() {
  useOverlayStore.setState({
    snapshot: {
      url: "data:image/png;base64,iVBORw0KGgo=",
      sampleCtx: {
        canvas: { width: 1024, height: 768 },
      } as unknown as CanvasRenderingContext2D,
    },
  });
}

function selectRect(rect: Rect) {
  useOverlayStore.setState({ phase: "selected", rect });
}

afterEach(() => {
  cleanup();
  act(() => {
    useOverlayStore.getState().reset();
    useOverlayStore.setState({ mode: "region" });
  });
});

describe("SmallSelectionPreview — gating", () => {
  it("shows a magnified preview (with px readout) for a small selection", () => {
    seedSnapshot();
    selectRect({ x: 200, y: 200, w: 20, h: 16 });
    render(<SmallSelectionPreview />);
    // dpr defaults to 1 in jsdom, so the physical-px readout equals the rect.
    expect(screen.getByText("20 × 16")).toBeInTheDocument();
  });

  it("renders nothing for a comfortably-sized selection", () => {
    seedSnapshot();
    selectRect({ x: 200, y: 200, w: 200, h: 120 });
    const { container } = render(<SmallSelectionPreview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing until the snapshot has loaded", () => {
    // Small rect, but no snapshot yet — the loupe/preview have no pixels.
    selectRect({ x: 200, y: 200, w: 20, h: 16 });
    const { container } = render(<SmallSelectionPreview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing in the empty/idle phases (no selection yet)", () => {
    seedSnapshot();
    act(() => useOverlayStore.setState({ phase: "idle", rect: null }));
    const { container } = render(<SmallSelectionPreview />);
    expect(container).toBeEmptyDOMElement();
  });

  it("previews a thin selection (one tiny side) too", () => {
    seedSnapshot();
    selectRect({ x: 100, y: 100, w: 40, h: 10 }); // longSide 40 < 45
    render(<SmallSelectionPreview />);
    expect(screen.getByText("40 × 10")).toBeInTheDocument();
  });
});

describe("isTinySelection", () => {
  it("is true only when the larger side is under the threshold", () => {
    expect(isTinySelection({ x: 0, y: 0, w: 20, h: 16 })).toBe(true);
    expect(isTinySelection({ x: 0, y: 0, w: 44, h: 10 })).toBe(true); // long side 44
    expect(isTinySelection({ x: 0, y: 0, w: 45, h: 10 })).toBe(false); // hits threshold
    expect(isTinySelection({ x: 0, y: 0, w: 200, h: 120 })).toBe(false);
    expect(isTinySelection(null)).toBe(false);
    expect(isTinySelection({ x: 0, y: 0, w: 0, h: 0 })).toBe(false);
  });
});

describe("SmallSelectionPreview — move handle", () => {
  it("becomes a drag-to-move handle once the selection is committed", () => {
    seedSnapshot();
    selectRect({ x: 200, y: 200, w: 20, h: 16 });
    const beginMove = vi.fn();
    const { container } = render(
      <SmallSelectionPreview beginMove={beginMove} />
    );
    const handle = container.querySelector('[data-move-handle="true"]');
    expect(handle).not.toBeNull();
    // Pointer-down on the magnified view starts a move with the current rect.
    fireEvent.pointerDown(handle!);
    expect(beginMove).toHaveBeenCalledTimes(1);
    expect(beginMove.mock.calls[0]![0]).toEqual({
      x: 200,
      y: 200,
      w: 20,
      h: 16,
    });
  });

  it("stays presentational (no move handle) while still dragging out the box", () => {
    seedSnapshot();
    act(() =>
      useOverlayStore.setState({
        phase: "dragging",
        start: { x: 200, y: 200 },
        cur: { x: 220, y: 216 },
      })
    );
    const beginMove = vi.fn();
    const { container } = render(
      <SmallSelectionPreview beginMove={beginMove} />
    );
    expect(container.querySelector("[data-move-handle]")).toBeNull();
  });
});

describe("SmallSelectionPreview — placement", () => {
  it("centres horizontally and parks above the selection when no action bar", () => {
    const { left, top } = place(
      { x: 100, y: 300, w: 20, h: 20 },
      160,
      160,
      1024,
      768,
      null
    );
    expect(left).toBe(30); // centre 110 - boxW/2 80
    expect(top).toBe(106); // above: 300 - GAP(16) - (160 + label 18)
  });

  it("stays on the opposite side from a below action bar (no overlap)", () => {
    // Mirrors SelectionActionBar: bar sits ~12px below the selection, centred.
    const bar = { x: 287, y: 332, w: 250, h: 44 };
    const { left, top } = place(
      { x: 400, y: 300, w: 24, h: 20 },
      160,
      160,
      1024,
      768,
      bar
    );
    expect(left).toBe(332);
    expect(top).toBe(106); // above the selection; preview bottom 284 < bar top 332
    expect(top + 178).toBeLessThanOrEqual(bar.y); // provably clear of the bar
  });

  it("stacks below the action bar when the selection hugs the top edge", () => {
    const bar = { x: 287, y: 42, w: 250, h: 44 }; // bar below a near-top selection
    const { top } = place(
      { x: 400, y: 10, w: 24, h: 20 },
      160,
      160,
      1024,
      768,
      bar
    );
    // No room above → drop under the bar: bar.y(42) + bar.h(44) + GAP(16) = 102.
    expect(top).toBe(102);
    expect(top).toBeGreaterThanOrEqual(bar.y + bar.h); // below the bar
  });

  it("centres horizontally and clamps at the right edge", () => {
    const { left } = place(
      { x: 950, y: 300, w: 24, h: 20 },
      160,
      160,
      1024,
      768,
      null
    );
    expect(left).toBe(852); // clamped: vw - EDGE_PAD(12) - boxW(160)
  });
});
