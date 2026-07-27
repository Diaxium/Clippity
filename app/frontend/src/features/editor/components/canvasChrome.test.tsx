import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useEditorStore } from "../state/editorStore";
import { emptyScene } from "../lib/seed";
import { makeRectangle } from "../types";
import { CanvasGrid, gridLayerStyle } from "./CanvasGrid";
import { canvasHint, CanvasHintBar } from "./CanvasHintBar";
import { CanvasZoomControls } from "./CanvasZoomControls";

const state = () => useEditorStore.getState();

afterEach(cleanup);

describe("gridLayerStyle", () => {
  it("locks the pitch to scene space and pins to the pan origin", () => {
    const s = gridLayerStyle({ zoom: 1, panX: 40, panY: 12 });
    // base step 8 → 8px < 14 → doubles to 16px at zoom 1.
    expect(s.backgroundSize).toBe("16px 16px");
    expect(s.backgroundPosition).toBe("40px 12px");
  });

  it("grows the pitch as you zoom out and fades at extreme zoom-out", () => {
    expect(gridLayerStyle({ zoom: 4, panX: 0, panY: 0 }).backgroundSize).toBe(
      "32px 32px"
    );
    expect(gridLayerStyle({ zoom: 0.3, panX: 0, panY: 0 }).opacity).toBe(0.5);
    expect(gridLayerStyle({ zoom: 1, panX: 0, panY: 0 }).opacity).toBe(1);
  });

  it("renders only when shown", () => {
    const { container, rerender } = render(
      <CanvasGrid viewport={{ zoom: 1, panX: 0, panY: 0 }} show={false} />
    );
    expect(container.firstChild).toBeNull();
    rerender(<CanvasGrid viewport={{ zoom: 1, panX: 0, panY: 0 }} show />);
    expect(container.firstChild).not.toBeNull();
  });
});

describe("canvasHint", () => {
  it("prefers gesture state over tool/selection", () => {
    expect(canvasHint("select", 1, "resize")).toMatch(/resize/i);
    expect(canvasHint("select", 1, "rotate")).toMatch(/rotate/i);
    expect(canvasHint("select", 0, "move")).toMatch(/move/i);
    expect(canvasHint("select", 0, "pan")).toBeNull();
  });

  it("falls back to tool then selection", () => {
    expect(canvasHint("text", 0, null)).toMatch(/add text/i);
    expect(canvasHint("rectangle", 0, null)).toMatch(/draw a rectangle/i);
    expect(canvasHint("select", 2, null)).toMatch(/drag to move/i);
    expect(canvasHint("select", 0, null)).toMatch(/select a layer/i);
  });

  it("hides the bar (null hint) while panning", () => {
    state().loadScene(emptyScene());
    state().setActiveGesture("pan");
    const { container } = render(<CanvasHintBar />);
    expect(container.firstChild).toBeNull();
  });
});

describe("CanvasZoomControls wiring", () => {
  it("steps zoom, toggles grid inline, and applies a preset", () => {
    state().loadScene(emptyScene());
    state().setZoom(1);
    render(<CanvasZoomControls />);

    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(state().viewport.zoom).toBeGreaterThan(1);

    // Grid and snapping are direct toggles in the cluster, not menu items.
    expect(state().showGrid).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Grid" }));
    expect(state().showGrid).toBe(false);

    // Percent caret opens its own menu; a preset sets the exact zoom.
    fireEvent.click(screen.getByTitle("Zoom options"));
    fireEvent.click(screen.getByRole("menuitem", { name: "200%" }));
    expect(state().viewport.zoom).toBe(2);
  });

  it("toggles snapping inline and rulers from the overflow menu", () => {
    state().loadScene(emptyScene());
    render(<CanvasZoomControls />);
    expect(state().snapEnabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Snap" }));
    expect(state().snapEnabled).toBe(false);

    fireEvent.click(screen.getByLabelText("View options"));
    expect(state().showRulers).toBe(true);
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Show rulers" })
    );
    expect(state().showRulers).toBe(false);
  });

  it("centers the scene in the viewport keeping zoom", () => {
    state().loadScene(emptyScene());
    // Give the canvas a size + an off-center node so centering has work to do.
    state().setCanvasSize(800, 600);
    state().addNode(
      makeRectangle(
        { x: 1000, y: 1000, width: 100, height: 100 },
        { name: "R" }
      )
    );
    state().setZoom(2);
    render(<CanvasZoomControls />);
    fireEvent.click(screen.getByLabelText("View options"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Center view" }));
    const vp = state().viewport;
    expect(vp.zoom).toBe(2); // zoom unchanged
    // Node center (1050,1050) maps to the viewport center (400,300).
    expect(1050 * vp.zoom + vp.panX).toBeCloseTo(400, 3);
    expect(1050 * vp.zoom + vp.panY).toBeCloseTo(300, 3);
  });

  it("accepts a free-form percent typed into the field", () => {
    state().loadScene(emptyScene());
    state().setZoom(1);
    render(<CanvasZoomControls />);
    const field = screen.getByLabelText("Zoom percent");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "137" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(state().viewport.zoom).toBeCloseTo(1.37, 5);
  });

  it("clamps an out-of-range typed percent to the zoom limits", () => {
    state().loadScene(emptyScene());
    state().setZoom(1);
    render(<CanvasZoomControls />);
    const field = screen.getByLabelText("Zoom percent");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "1" } }); // 1% → below MIN_ZOOM (2%)
    fireEvent.blur(field);
    expect(state().viewport.zoom).toBeCloseTo(0.02, 5);
  });
});
