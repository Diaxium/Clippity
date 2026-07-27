import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useEditorStore } from "../state/editorStore";
import { KeybindHelpOverlay } from "./KeybindHelpOverlay";

const state = () => useEditorStore.getState();

afterEach(() => {
  cleanup();
  state().setHelpOpen(false);
});

describe("KeybindHelpOverlay", () => {
  it("renders nothing while closed", () => {
    state().setHelpOpen(false);
    const { queryByText } = render(<KeybindHelpOverlay />);
    expect(queryByText("Keyboard shortcuts")).toBeNull();
  });

  it("lists registered shortcuts grouped by category", () => {
    state().setHelpOpen(true);
    const { getByText, getByRole } = render(<KeybindHelpOverlay />);
    expect(
      getByRole("heading", { name: "Keyboard shortcuts" })
    ).toBeInTheDocument();
    // Category headers + representative bindings from several groups.
    expect(getByText("Tools")).toBeInTheDocument();
    expect(getByText("Layers")).toBeInTheDocument();
    expect(getByText("Transform / Resize")).toBeInTheDocument();
    expect(getByText("Duplicate")).toBeInTheDocument();
    expect(getByText("Group selection")).toBeInTheDocument();
    expect(getByText("Zoom to selection")).toBeInTheDocument();
  });

  it("filters by query", () => {
    state().setHelpOpen(true);
    const { getByLabelText, queryByText, getByText } = render(
      <KeybindHelpOverlay />
    );
    fireEvent.change(getByLabelText("Filter shortcuts"), {
      target: { value: "duplicate" },
    });
    expect(getByText("Duplicate")).toBeInTheDocument();
    expect(queryByText("Bring forward")).toBeNull();
  });

  it("closes via the close button", () => {
    state().setHelpOpen(true);
    const { getByLabelText, queryByText } = render(<KeybindHelpOverlay />);
    fireEvent.click(getByLabelText("Close shortcuts"));
    expect(state().helpOpen).toBe(false);
    expect(queryByText("Keyboard shortcuts")).toBeNull();
  });

  it("closes on Escape", () => {
    state().setHelpOpen(true);
    render(<KeybindHelpOverlay />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(state().helpOpen).toBe(false);
  });
});
