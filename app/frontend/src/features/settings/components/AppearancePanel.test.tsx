import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AppearanceSettings } from "../types";
import { AppearancePanel } from "./AppearancePanel";

const base: AppearanceSettings = {
  theme: "system",
  accent: "#FF6E4A",
  windowOpacity: 100,
  uiScale: 100,
  cornerRadius: "default",
  density: "comfortable",
  appIcon: "color",
};

describe("AppearancePanel", () => {
  it("selects a corner-roundness option", () => {
    const onChange = vi.fn();
    render(<AppearancePanel value={base} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Round" }));
    expect(onChange).toHaveBeenCalledWith({ ...base, cornerRadius: "round" });
  });

  it("selects the compact density", () => {
    const onChange = vi.fn();
    render(<AppearancePanel value={base} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onChange).toHaveBeenCalledWith({ ...base, density: "compact" });
  });

  it("switches the app-icon style to monochrome", () => {
    const onChange = vi.fn();
    render(<AppearancePanel value={base} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Monochrome" }));
    expect(onChange).toHaveBeenCalledWith({ ...base, appIcon: "monochrome" });
  });

  it("drives the window-transparency slider", () => {
    const onChange = vi.fn();
    render(<AppearancePanel value={base} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Window opacity"), {
      target: { value: "70" },
    });
    expect(onChange).toHaveBeenCalledWith({ ...base, windowOpacity: 70 });
  });

  it("drives the interface-scale slider", () => {
    const onChange = vi.fn();
    render(<AppearancePanel value={base} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Interface scale"), {
      target: { value: "110" },
    });
    expect(onChange).toHaveBeenCalledWith({ ...base, uiScale: 110 });
  });

  it("no longer renders a reduce-motion control (moved to Performance)", () => {
    render(<AppearancePanel value={base} onChange={vi.fn()} />);
    expect(screen.queryByText("Reduce motion")).toBeNull();
  });
});
