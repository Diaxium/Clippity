import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useOverlayStore } from "../state/overlayStore";
import { selectionTipsFor, SelectionTips } from "./SelectionTips";

afterEach(() => {
  cleanup();
  act(() => {
    useOverlayStore.getState().reset();
    useOverlayStore.setState({ mode: "region" });
  });
});

describe("selectionTipsFor", () => {
  it("surfaces precision and last-region shortcuts before a rectangle is drawn", () => {
    expect(selectionTipsFor("region", "idle")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keys: ["Shift"], label: "Square" }),
        expect.objectContaining({ keys: ["Alt"], label: "Precision" }),
        expect.objectContaining({ keys: ["L"], label: "Last region" }),
      ])
    );
  });

  it("switches rectangle tips to adjustment shortcuts once selected", () => {
    expect(selectionTipsFor("region", "selected")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keys: ["Enter"], label: "Capture" }),
        expect.objectContaining({ keys: ["Arrows"], label: "Nudge 1 px" }),
        expect.objectContaining({
          keys: ["Shift", "Arrows"],
          label: "Nudge 10 px",
        }),
        expect.objectContaining({
          keys: ["Alt", "Arrows"],
          label: "Resize",
        }),
      ])
    );
  });

  it("uses mode-specific drawing tips for pen selections", () => {
    expect(selectionTipsFor("pen", "dragging")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keys: ["Click"], label: "Add anchor" }),
        expect.objectContaining({ keys: ["Alt", "Drag"], label: "Cusp" }),
        expect.objectContaining({ keys: ["Enter"], label: "Close path" }),
      ])
    );
  });
});

describe("SelectionTips", () => {
  it("renders the active mode tips", () => {
    act(() => {
      useOverlayStore.setState({ mode: "brush", phase: "idle" });
    });

    render(<SelectionTips />);

    expect(screen.getByLabelText("Selection tips")).toBeInTheDocument();
    expect(screen.getByText("Paint")).toBeInTheDocument();
    expect(screen.getByText("Brush size")).toBeInTheDocument();
  });

  it("hides while the full shortcut sheet is open", () => {
    act(() => {
      useOverlayStore.setState({
        mode: "region",
        phase: "idle",
        helpOpen: true,
      });
    });

    render(<SelectionTips />);

    expect(screen.queryByLabelText("Selection tips")).toBeNull();
  });
});
