import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useOverlayStore } from "../state/overlayStore";
import type { Rect } from "../types";
import { RegionSelection } from "./RegionSelection";

const noop = () => {};

function renderSelection() {
  return render(
    <RegionSelection
      editable
      beginMove={noop}
      beginResize={noop}
      onSelectionPointerMove={noop}
      onSelectionPointerUp={noop}
    />
  );
}

function commit(rect: Rect, withSnapshot: boolean) {
  useOverlayStore.setState({
    phase: "selected",
    rect,
    snapshot: withSnapshot
      ? {
          url: "data:image/png;base64,iVBORw0KGgo=",
          sampleCtx: {
            canvas: { width: 1024, height: 768 },
          } as unknown as CanvasRenderingContext2D,
        }
      : { url: null, sampleCtx: null },
  });
}

afterEach(() => {
  cleanup();
  act(() => {
    useOverlayStore.getState().reset();
    useOverlayStore.setState({ mode: "region" });
  });
});

describe("RegionSelection — size badge vs. magnified preview", () => {
  it("shows its size badge for a normal selection", () => {
    commit({ x: 100, y: 100, w: 200, h: 120 }, true);
    renderSelection();
    expect(screen.getByText("200 × 120")).toBeInTheDocument();
  });

  it("hides its size badge for a tiny selection (the preview shows the size)", () => {
    commit({ x: 100, y: 100, w: 20, h: 16 }, true);
    renderSelection();
    expect(screen.queryByText("20 × 16")).toBeNull();
  });

  it("keeps the badge for a tiny selection while the snapshot is still loading", () => {
    // No snapshot → the preview can't render, so the badge stays as the fallback.
    commit({ x: 100, y: 100, w: 20, h: 16 }, false);
    renderSelection();
    expect(screen.getByText("20 × 16")).toBeInTheDocument();
  });
});

describe("RegionSelection — resize handles scale with a small selection", () => {
  const handleCount = (c: HTMLElement) =>
    c.querySelectorAll(".ovl-handle").length;

  it("renders all eight handles for a comfortably-sized selection", () => {
    commit({ x: 100, y: 100, w: 200, h: 120 }, false);
    const { container } = renderSelection();
    expect(handleCount(container)).toBe(8);
  });

  it("drops the mid-edge handles for a tiny selection (corners only)", () => {
    commit({ x: 100, y: 100, w: 28, h: 22 }, false);
    const { container } = renderSelection();
    expect(handleCount(container)).toBe(4);
  });

  it("keeps top/bottom edges but drops left/right for a wide, short selection", () => {
    commit({ x: 100, y: 100, w: 160, h: 24 }, false);
    const { container } = renderSelection();
    // 4 corners + n + s; e/w dropped because the box is only 24 px tall.
    expect(handleCount(container)).toBe(6);
  });

  it("shrinks the handle below full size when the box is small", () => {
    commit({ x: 100, y: 100, w: 24, h: 24 }, false);
    const { container } = renderSelection();
    const corner = container.querySelector(".ovl-handle") as HTMLElement;
    // Full size is 10 px; a 24 px box scales it down.
    expect(parseInt(corner.style.width, 10)).toBeLessThan(10);
  });
});
