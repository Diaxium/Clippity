import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useOverlayStore } from "../state/overlayStore";
import type { DetectedObject } from "../types";
import { ObjectHighlights } from "./ObjectHighlights";

function showHovered(rect: DetectedObject["rect"]) {
  useOverlayStore.setState({
    mode: "object",
    objectsStatus: "ready",
    objects: [{ rect, label: "UI element", confidence: 0.95 }],
    hoveredObjectIndex: 0,
  });
}

afterEach(() => {
  // Unmount first so the store reset below doesn't re-render a still-
  // mounted subscriber outside act().
  cleanup();
  act(() => {
    useOverlayStore.getState().reset();
    useOverlayStore.setState({ mode: "region" });
  });
});

describe("ObjectHighlights — hovered label", () => {
  it("shows the full 'name · confidence' text without truncation", () => {
    showHovered({ x: 40, y: 600, width: 48, height: 48 }); // small box
    render(<ObjectHighlights />);
    const label = screen.getByText("UI element · 95%");
    // No width clamp / ellipsis — the whole label must read even when the
    // detected element is tiny. (The bug: max-w-full + truncate.)
    expect(label.className).toContain("whitespace-nowrap");
    expect(label.className).not.toContain("truncate");
    expect(label.className).not.toContain("max-w-full");
  });

  it("parks the label ABOVE the box (outside it) when there's room", () => {
    showHovered({ x: 40, y: 600, width: 200, height: 80 });
    render(<ObjectHighlights />);
    const label = screen.getByText("UI element · 95%");
    // Above = anchored to the box's bottom edge via `bottom: 100% + gap`,
    // i.e. it sits entirely outside the top of the box.
    expect(label.style.bottom).toBe("calc(100% + 6px)");
    expect(label.style.top).toBe("");
  });

  it("flips the label BELOW the box when it hugs the top edge", () => {
    showHovered({ x: 40, y: 8, width: 200, height: 80 }); // near top
    render(<ObjectHighlights />);
    const label = screen.getByText("UI element · 95%");
    expect(label.style.top).toBe("calc(100% + 6px)");
    expect(label.style.bottom).toBe("");
  });

  it("grows leftward for a box on the right of the screen", () => {
    // jsdom viewport width defaults to 1024; 800 > 0.6 * 1024.
    showHovered({ x: 800, y: 600, width: 180, height: 60 });
    render(<ObjectHighlights />);
    const label = screen.getByText("UI element · 95%");
    expect(label.style.right).toBe("0px");
    expect(label.style.left).toBe("");
  });

  it("anchors to the left for a box on the left of the screen", () => {
    showHovered({ x: 40, y: 600, width: 180, height: 60 });
    render(<ObjectHighlights />);
    const label = screen.getByText("UI element · 95%");
    expect(label.style.left).toBe("0px");
    expect(label.style.right).toBe("");
  });
});
