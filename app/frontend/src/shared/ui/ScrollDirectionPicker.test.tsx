import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ScrollDirectionPicker } from "./ScrollDirectionPicker";

describe("ScrollDirectionPicker", () => {
  it("renders all four directions and marks the active one checked", () => {
    render(<ScrollDirectionPicker value="down" onChange={() => {}} />);
    const down = screen.getByRole("radio", { name: "Scroll down" });
    const up = screen.getByRole("radio", { name: "Scroll up" });
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(down).toHaveAttribute("aria-checked", "true");
    expect(up).toHaveAttribute("aria-checked", "false");
  });

  it("calls onChange with the picked direction", () => {
    const onChange = vi.fn();
    render(<ScrollDirectionPicker value="down" onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: "Scroll right" }));
    expect(onChange).toHaveBeenCalledWith("right");
  });

  it("does not fire when disabled", () => {
    const onChange = vi.fn();
    render(
      <ScrollDirectionPicker value="down" onChange={onChange} disabled />
    );
    fireEvent.click(screen.getByRole("radio", { name: "Scroll left" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
