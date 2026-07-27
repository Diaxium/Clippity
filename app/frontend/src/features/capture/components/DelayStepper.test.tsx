import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { DelayStepper } from "./DelayStepper";

describe("DelayStepper", () => {
  it("increments and decrements within bounds", () => {
    const onChange = vi.fn();
    render(<DelayStepper value={5} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /increase/i }));
    expect(onChange).toHaveBeenLastCalledWith(6);
    fireEvent.click(screen.getByRole("button", { name: /decrease/i }));
    expect(onChange).toHaveBeenLastCalledWith(4);
  });

  it("clamps at min", () => {
    const onChange = vi.fn();
    render(<DelayStepper value={1} onChange={onChange} min={1} />);
    const minus = screen.getByRole("button", { name: /decrease/i });
    expect(minus).toBeDisabled();
    fireEvent.click(minus);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clamps at max", () => {
    const onChange = vi.fn();
    render(<DelayStepper value={60} onChange={onChange} max={60} />);
    const plus = screen.getByRole("button", { name: /increase/i });
    expect(plus).toBeDisabled();
    fireEvent.click(plus);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disabled blocks all interactions", () => {
    const onChange = vi.fn();
    render(<DelayStepper value={5} onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole("button", { name: /increase/i }));
    fireEvent.click(screen.getByRole("button", { name: /decrease/i }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts typed-in values within range", () => {
    const onChange = vi.fn();
    render(<DelayStepper value={5} onChange={onChange} />);
    const input = screen.getByRole("spinbutton", { name: /delay in seconds/i });
    fireEvent.change(input, { target: { value: "12" } });
    expect(onChange).toHaveBeenCalledWith(12);
  });

  it("clamps typed-in values to the range", () => {
    const onChange = vi.fn();
    render(<DelayStepper value={5} onChange={onChange} min={1} max={60} />);
    const input = screen.getByRole("spinbutton", { name: /delay in seconds/i });
    fireEvent.change(input, { target: { value: "9999" } });
    expect(onChange).toHaveBeenLastCalledWith(60);
    fireEvent.change(input, { target: { value: "-3" } });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});
