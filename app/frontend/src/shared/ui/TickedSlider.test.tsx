import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TickedSlider } from "./TickedSlider";
import { intervalFractions } from "./TrackTicks";

function renderSlider(
  overrides: Partial<Parameters<typeof TickedSlider>[0]> = {}
) {
  const onChange = vi.fn();
  render(
    <TickedSlider
      value={25}
      min={5}
      max={95}
      step={5}
      onChange={onChange}
      ariaLabel="Sensitivity"
      formatValue={(v) => `${v}%`}
      {...overrides}
    />
  );
  const input = screen.getByLabelText("Sensitivity") as HTMLInputElement;
  return { onChange, input };
}

describe("TickedSlider — lag fix (commit on settle, not per input)", () => {
  it("does NOT commit while dragging, only on pointer-up", () => {
    const { onChange, input } = renderSlider();

    // Simulate a drag: several intermediate input events.
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.change(input, { target: { value: "55" } });
    fireEvent.change(input, { target: { value: "70" } });
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(70);
  });

  it("commits on key-up (keyboard adjustment)", () => {
    const { onChange, input } = renderSlider();
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.keyUp(input, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(30);
  });

  it("commits on blur (drag released off the element)", () => {
    const { onChange, input } = renderSlider();
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(60);
  });

  it("does not commit when the value is unchanged", () => {
    const { onChange, input } = renderSlider();
    // Settle without ever firing an input change.
    fireEvent.pointerUp(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("updates the live readout from the draft during a drag", () => {
    const { input } = renderSlider();
    expect(screen.getByText("25%")).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "80" } });
    // Readout reflects the draft immediately, before any commit.
    expect(screen.getByText("80%")).toBeInTheDocument();
  });

  it("emits preview values during a drag without committing", () => {
    const onPreview = vi.fn();
    const { onChange, input } = renderSlider({ onPreview });
    fireEvent.change(input, { target: { value: "65" } });
    expect(onPreview).toHaveBeenCalledWith(65);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adopts an external value change when idle", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TickedSlider
        value={25}
        min={5}
        max={95}
        step={5}
        onChange={onChange}
        ariaLabel="Sensitivity"
        formatValue={(v) => `${v}%`}
      />
    );
    expect(screen.getByText("25%")).toBeInTheDocument();
    rerender(
      <TickedSlider
        value={50}
        min={5}
        max={95}
        step={5}
        onChange={onChange}
        ariaLabel="Sensitivity"
        formatValue={(v) => `${v}%`}
      />
    );
    expect(screen.getByText("50%")).toBeInTheDocument();
  });
});

describe("intervalFractions", () => {
  it("places ticks on the interior multiples of step", () => {
    const fr = intervalFractions(0, 100, 25);
    expect(fr).toHaveLength(3);
    expect(fr[0]).toBeCloseTo(0.25);
    expect(fr[1]).toBeCloseTo(0.5);
    expect(fr[2]).toBeCloseTo(0.75);
  });

  it("excludes the range endpoints", () => {
    // 5..95 every 20 → 20/40/60/80 (not 5 or 95).
    const fr = intervalFractions(5, 95, 20);
    expect(fr).toHaveLength(4);
    expect(fr[0]).toBeCloseTo((20 - 5) / 90);
    expect(fr[3]).toBeCloseTo((80 - 5) / 90);
  });

  it("returns nothing for degenerate inputs", () => {
    expect(intervalFractions(5, 95, 0)).toEqual([]);
    expect(intervalFractions(50, 50, 10)).toEqual([]);
    // step larger than the whole range → no interior ticks.
    expect(intervalFractions(0, 100, 200)).toEqual([]);
  });
});
