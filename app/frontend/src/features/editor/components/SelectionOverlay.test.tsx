import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeFreeformLine,
  makeFreeformPoints,
  makeGradientPaint,
  makeMesh,
  makeRectangle,
} from "../types";
import { SelectionOverlay } from "./SelectionOverlay";

afterEach(cleanup);

const viewport = { zoom: 1, panX: 0, panY: 0 };

function gradientRect(kind: "linear" | "radial" | "freeform") {
  __resetNodeIdForTests();
  const r = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
  const paint = makeGradientPaint();
  paint.gradient!.kind = kind;
  if (kind === "freeform") paint.gradient!.points = makeFreeformPoints();
  r.fills = [paint];
  return { r, paint };
}

function renderOverlay(
  r: ReturnType<typeof gradientRect>["r"],
  gradientEditFillId: string | null
) {
  return render(
    <SelectionOverlay
      nodes={{ [r.id]: r }}
      selectedIds={[r.id]}
      viewport={viewport}
      hoverId={null}
      marquee={null}
      interacting={false}
      gradientEditFillId={gradientEditFillId}
    />
  );
}

describe("SelectionOverlay gradient handles", () => {
  it("shows start/end handles for a linear gradient being edited", () => {
    const { r, paint } = gradientRect("linear");
    const { container } = renderOverlay(r, paint.id);
    expect(container.querySelector('[data-grad="start"]')).not.toBeNull();
    expect(container.querySelector('[data-grad="end"]')).not.toBeNull();
  });

  it("shows center/radius/focal handles for a radial gradient", () => {
    const { r, paint } = gradientRect("radial");
    const { container } = renderOverlay(r, paint.id);
    expect(container.querySelector('[data-grad="center"]')).not.toBeNull();
    expect(container.querySelector('[data-grad="radius"]')).not.toBeNull();
    expect(container.querySelector('[data-grad="focal"]')).not.toBeNull();
  });

  it("shows one handle per point for a freeform gradient", () => {
    const { r, paint } = gradientRect("freeform");
    const { container } = renderOverlay(r, paint.id);
    expect(container.querySelectorAll('[data-grad="point"]').length).toBe(3);
  });

  it("shows stop handles + a polyline for a freeform line", () => {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    const paint = makeGradientPaint();
    paint.gradient!.kind = "freeform";
    paint.gradient!.freeformMode = "lines";
    paint.gradient!.lines = [makeFreeformLine()];
    r.fills = [paint];
    const { container } = renderOverlay(r, paint.id);
    expect(container.querySelectorAll('[data-grad="point"]').length).toBe(3);
    expect(container.querySelector("polyline")).not.toBeNull();
  });

  it("shows a draggable node per mesh point plus lattice lines", () => {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    const paint = makeGradientPaint();
    paint.gradient!.kind = "mesh";
    paint.gradient!.mesh = makeMesh(); // 2×2 → 4 nodes
    r.fills = [paint];
    const { container } = renderOverlay(r, paint.id);
    const dots = container.querySelectorAll('[data-grad="mesh"]');
    expect(dots.length).toBe(4);
    // Each carries its grid index so the drag knows which node to move.
    expect([...dots].map((d) => d.getAttribute("data-grad-id")).sort()).toEqual([
      "0",
      "1",
      "2",
      "3",
    ]);
    // Lattice lines (2 rows + 2 cols) make the warp legible.
    expect(container.querySelectorAll("polyline").length).toBe(4);
  });

  it("hides handles when no gradient is being edited", () => {
    const { r } = gradientRect("linear");
    const { container } = renderOverlay(r, null);
    expect(container.querySelector("[data-grad]")).toBeNull();
  });
});

describe("SelectionOverlay callout tail handle", () => {
  it("shows a tail handle on a selected callout, positioned at its tip", () => {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    r.callout = { angle: 180, length: 40 }; // straight down → tip at (50, 140)
    const { container } = renderOverlay(r, null);
    const handle = container.querySelector('[data-callout="tail"]');
    expect(handle).not.toBeNull();
    expect(Number(handle!.getAttribute("cx"))).toBeCloseTo(50, 6);
    expect(Number(handle!.getAttribute("cy"))).toBeCloseTo(140, 6);
  });

  it("shows no tail handle on a plain rectangle", () => {
    __resetNodeIdForTests();
    const r = makeRectangle({ x: 0, y: 0, width: 100, height: 100 });
    const { container } = renderOverlay(r, null);
    expect(container.querySelector("[data-callout]")).toBeNull();
  });
});
