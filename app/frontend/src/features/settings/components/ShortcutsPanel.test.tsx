import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ShortcutsSettings } from "../types";
import { ShortcutsPanel } from "./ShortcutsPanel";

function base(overrides: Partial<ShortcutsSettings> = {}): ShortcutsSettings {
  return {
    overrides: {},
    globalCapture: "Mod+Shift+2",
    globalCaptureEnabled: true,
    ...overrides,
  };
}

describe("ShortcutsPanel", () => {
  it("renders the capture, library, and editor sections", () => {
    render(<ShortcutsPanel value={base()} onChange={() => {}} />);
    expect(
      screen.getByRole("heading", { name: "Global capture hotkey" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Capture" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Library" })).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { name: /^Editor · / }).length
    ).toBeGreaterThan(0);
  });

  it("records a new combo into overrides for a binding", () => {
    const onChange = vi.fn();
    render(<ShortcutsPanel value={base()} onChange={onChange} />);

    // Undo lives under Editor · Editing with its default Ctrl+Z chip.
    const record = screen.getByRole("button", {
      name: "Record shortcut for Undo",
    });
    fireEvent.click(record);
    // While armed the recorder swallows keys; press Ctrl+U.
    fireEvent.keyDown(window, { key: "u", code: "KeyU", ctrlKey: true });

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as ShortcutsSettings;
    expect(next.overrides["editor:undo"]).toEqual(["Mod+u"]);
  });

  it("flags a conflict when two bindings share a key in one context", () => {
    // Remap undo onto select-all's Ctrl+A (both editor context).
    render(
      <ShortcutsPanel
        value={base({ overrides: { "editor:undo": ["Mod+A"] } })}
        onChange={() => {}}
      />
    );
    expect(
      screen.getByText(/share the same keys within one area/i)
    ).toBeTruthy();
  });

  it("reset-all is disabled with no overrides and clears them when clicked", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ShortcutsPanel value={base()} onChange={onChange} />
    );
    const resetAll = screen.getByRole("button", { name: "Reset all" });
    expect((resetAll as HTMLButtonElement).disabled).toBe(true);

    rerender(
      <ShortcutsPanel
        value={base({ overrides: { "editor:undo": ["Mod+U"] } })}
        onChange={onChange}
      />
    );
    const resetAll2 = screen.getByRole("button", { name: "Reset all" });
    expect((resetAll2 as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(resetAll2);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ overrides: {} })
    );
  });

  it("toggles the global capture hotkey", () => {
    const onChange = vi.fn();
    render(<ShortcutsPanel value={base()} onChange={onChange} />);
    const globalSection = screen
      .getByRole("heading", { name: "Global capture hotkey" })
      .closest("section")!;
    const toggle = within(globalSection).getByRole("switch");
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ globalCaptureEnabled: false })
    );
  });
});
