import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  makeFreeformPoints,
  makeGradientPaint,
  makeImagePaint,
  makeMesh,
  makeSolidPaint,
} from "../../types";
import { FillPicker } from "./FillPicker";

afterEach(cleanup);

describe("FillPicker header", () => {
  it("edits the per-fill blend mode from the header", () => {
    const paint = makeSolidPaint("#ffffff", 1);
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    fireEvent.click(screen.getByLabelText("Blend mode"));
    fireEvent.click(screen.getByRole("option", { name: "Multiply" }));
    expect(onChange.mock.calls.at(-1)![0].blendMode).toBe("multiply");
  });
});

describe("FillPicker mesh", () => {
  it("seeds a mesh when switching to a mesh gradient", () => {
    const paint = makeGradientPaint(); // linear
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    fireEvent.click(screen.getByLabelText("Gradient type"));
    fireEvent.click(screen.getByRole("option", { name: "Mesh" }));
    const patch = onChange.mock.calls.at(-1)![0];
    expect(patch.gradient.kind).toBe("mesh");
    expect(patch.gradient.mesh.points).toHaveLength(4); // 2×2
  });

  it("renders a cell per point and resizes the grid", () => {
    const paint = makeGradientPaint();
    paint.gradient!.kind = "mesh";
    paint.gradient!.mesh = makeMesh(); // 2×2 = 4 cells
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    expect(screen.getAllByLabelText("Mesh cell")).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("Mesh rows"), {
      target: { value: "3" },
    });
    const patch = onChange.mock.calls.at(-1)![0];
    expect(patch.gradient.mesh.rows).toBe(3);
    expect(patch.gradient.mesh.points).toHaveLength(6); // 3 rows × 2 cols
  });
});

describe("FillPicker image", () => {
  it("edits image scale and position", () => {
    const paint = makeImagePaint("data:image/png;base64,AAA");
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    fireEvent.click(screen.getByLabelText("Image scale"));
    fireEvent.click(screen.getByRole("option", { name: "Fit" }));
    expect(onChange.mock.calls.at(-1)![0].imageScale).toBe("fit");

    fireEvent.click(screen.getByLabelText("Image position"));
    fireEvent.click(screen.getByRole("option", { name: "Top left" }));
    expect(onChange.mock.calls.at(-1)![0].imageAlign).toBe("top-left");
  });
});

describe("FillPicker gradient", () => {
  it("toggles the radial profile to circle", () => {
    const paint = makeGradientPaint();
    paint.gradient!.kind = "radial";
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    fireEvent.click(screen.getByLabelText("Radial shape"));
    fireEvent.click(screen.getByRole("option", { name: "Circle" }));
    const patch = onChange.mock.calls.at(-1)![0];
    expect(patch.gradient.shape).toBe("circle");
  });

  it("does not show the shape control for a linear gradient", () => {
    const paint = makeGradientPaint(); // linear
    render(
      <FillPicker paint={paint} onChange={() => {}} onPickImage={() => {}} />
    );
    expect(screen.queryByLabelText("Radial shape")).toBeNull();
  });

  it("seeds color points when switching to a freeform gradient", () => {
    const paint = makeGradientPaint(); // linear, no points
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    fireEvent.click(screen.getByLabelText("Gradient type"));
    fireEvent.click(screen.getByRole("option", { name: "Freeform" }));
    const patch = onChange.mock.calls.at(-1)![0];
    expect(patch.gradient.kind).toBe("freeform");
    expect(patch.gradient.points.length).toBeGreaterThanOrEqual(3);
  });

  it("shows the point editor for freeform, not the stop controls", () => {
    const paint = makeGradientPaint();
    paint.gradient!.kind = "freeform";
    paint.gradient!.points = makeFreeformPoints();
    render(
      <FillPicker paint={paint} onChange={() => {}} onPickImage={() => {}} />
    );
    expect(screen.getByLabelText("Add color point")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add stop")).toBeNull();
  });

  it("edits a stop's opacity from its row", () => {
    const paint = makeGradientPaint(); // 2 stops
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    fireEvent.change(screen.getAllByLabelText("Stop opacity")[0]!, {
      target: { value: "50" },
    });
    expect(onChange.mock.calls.at(-1)![0].gradient.stops[0].opacity).toBe(0.5);
  });

  it("expands a stop's color picker only when its color is clicked", () => {
    const paint = makeGradientPaint();
    render(
      <FillPicker paint={paint} onChange={() => {}} onPickImage={() => {}} />
    );
    // No inline SV picker until requested — opening one adds its hex textbox.
    const before = screen.queryAllByRole("textbox").length;
    fireEvent.click(screen.getAllByLabelText("Stop color")[0]!);
    expect(screen.getAllByRole("textbox").length).toBeGreaterThan(before);
  });

  it("renders a draggable handle per stop", () => {
    const paint = makeGradientPaint(); // linear, 2 stops
    render(
      <FillPicker paint={paint} onChange={() => {}} onPickImage={() => {}} />
    );
    expect(screen.getAllByLabelText("Gradient stop handle")).toHaveLength(2);
  });

  it("adds a stop when the gradient track is pressed", () => {
    const paint = makeGradientPaint(); // 2 stops
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    fireEvent.pointerDown(screen.getByLabelText("Gradient track"));
    const patch = onChange.mock.calls.at(-1)![0];
    expect(patch.gradient.stops).toHaveLength(3);
  });

  it("seeds a line when switching freeform to lines mode", () => {
    const paint = makeGradientPaint();
    paint.gradient!.kind = "freeform";
    paint.gradient!.points = makeFreeformPoints();
    const onChange = vi.fn();
    render(
      <FillPicker paint={paint} onChange={onChange} onPickImage={() => {}} />
    );
    fireEvent.click(screen.getByText("lines"));
    const patch = onChange.mock.calls.at(-1)![0];
    expect(patch.gradient.freeformMode).toBe("lines");
    expect(patch.gradient.lines.length).toBeGreaterThanOrEqual(1);
  });
});
