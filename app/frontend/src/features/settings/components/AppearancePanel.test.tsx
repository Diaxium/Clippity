import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BACKDROP_TUNING_SET } from "../lib/backdrop";
import type { AppearanceSettings } from "../types";
import { AppearancePanel } from "./AppearancePanel";

const base: AppearanceSettings = {
  theme: "system",
  accent: "#FF6E4A",
  windowOpacity: 100,
  windowBackdrop: "mica",
  backdropTuning: DEFAULT_BACKDROP_TUNING_SET,
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

  it("previews window transparency while dragging and commits on release", () => {
    const onChange = vi.fn();
    render(<AppearancePanel value={base} onChange={onChange} />);
    const input = screen.getByLabelText("Window opacity");
    fireEvent.change(input, {
      target: { value: "70" },
    });
    expect(screen.getByText("70% opacity")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(input);
    expect(onChange).toHaveBeenCalledWith({ ...base, windowOpacity: 70 });
  });

  it("selects a window-backdrop material", () => {
    const onChange = vi.fn();
    render(<AppearancePanel value={base} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Acrylic" }));
    expect(onChange).toHaveBeenCalledWith({
      ...base,
      windowBackdrop: "acrylic",
    });
  });

  it("previews interface scale while dragging and commits on release", () => {
    const onChange = vi.fn();
    render(<AppearancePanel value={base} onChange={onChange} />);
    const input = screen.getByLabelText("Interface scale");
    fireEvent.change(input, {
      target: { value: "110" },
    });
    expect(screen.getByText("110% scale")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(input);
    expect(onChange).toHaveBeenCalledWith({ ...base, uiScale: 110 });
  });

  it("no longer renders a reduce-motion control (moved to Performance)", () => {
    render(<AppearancePanel value={base} onChange={vi.fn()} />);
    expect(screen.queryByText("Reduce motion")).toBeNull();
  });

  describe("backdrop tuning", () => {
    it("titles the tuning card after the selected material", () => {
      const { rerender } = render(
        <AppearancePanel value={base} onChange={vi.fn()} />
      );
      expect(screen.getByText("Mica tuning")).toBeInTheDocument();
      rerender(
        <AppearancePanel
          value={{ ...base, windowBackdrop: "clear" }}
          onChange={vi.fn()}
        />
      );
      expect(screen.getByText("Clear tuning")).toBeInTheDocument();
    });

    it("hides the material-tint slider on materials Windows tints itself", () => {
      const { rerender } = render(
        <AppearancePanel value={base} onChange={vi.fn()} />
      );
      expect(screen.queryByLabelText("Material tint")).toBeNull();
      rerender(
        <AppearancePanel
          value={{ ...base, windowBackdrop: "acrylic" }}
          onChange={vi.fn()}
        />
      );
      expect(screen.getByLabelText("Material tint")).toBeInTheDocument();
    });

    it("says outright that a wallpaper-derived material can't show live content", () => {
      const { rerender } = render(
        <AppearancePanel value={base} onChange={vi.fn()} />
      );
      expect(
        screen.getByText(/can never show through it at any transparency/)
      ).toBeInTheDocument();
      rerender(
        <AppearancePanel
          value={{ ...base, windowBackdrop: "acrylic" }}
          onChange={vi.fn()}
        />
      );
      expect(
        screen.queryByText(/can never show through it at any transparency/)
      ).toBeNull();
    });

    it("writes a tuning change to the selected material only", () => {
      const onChange = vi.fn();
      render(<AppearancePanel value={base} onChange={onChange} />);
      const slider = screen.getByLabelText("Panel fill");
      fireEvent.change(slider, { target: { value: "40" } });
      fireEvent.pointerUp(slider);
      expect(onChange).toHaveBeenCalledWith({
        ...base,
        backdropTuning: {
          ...DEFAULT_BACKDROP_TUNING_SET,
          mica: { ...DEFAULT_BACKDROP_TUNING_SET.mica, glassStrength: 40 },
        },
      });
    });

    it("disables Reset until the material is off its shipped tuning", () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <AppearancePanel value={base} onChange={onChange} />
      );
      expect(screen.getByRole("button", { name: /Reset/ })).toBeDisabled();

      const tuned: AppearanceSettings = {
        ...base,
        backdropTuning: {
          ...DEFAULT_BACKDROP_TUNING_SET,
          mica: { ...DEFAULT_BACKDROP_TUNING_SET.mica, saturation: 150 },
        },
      };
      rerender(<AppearancePanel value={tuned} onChange={onChange} />);
      fireEvent.click(screen.getByRole("button", { name: /Reset/ }));
      expect(onChange).toHaveBeenCalledWith({
        ...tuned,
        backdropTuning: DEFAULT_BACKDROP_TUNING_SET,
      });
    });
  });
});
