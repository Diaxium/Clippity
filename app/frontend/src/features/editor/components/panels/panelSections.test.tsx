import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useEditorStore } from "../../state/editorStore";
import {
  __resetNodeIdForTests,
  makeEllipse,
  makeLine,
  makePath,
  makePolygon,
  makeRectangle,
  makeStar,
  makeText,
  type PathNode,
  type PolygonNode,
  type SceneNode,
  type StarNode,
  type TextNode,
} from "../../types";
import { makeSpotlight } from "../../lib/spotlight";
import { CalloutSection } from "./CalloutSection";
import { EffectsSection } from "./EffectsSection";
import { MeasureSection } from "./MeasureSection";
import { SampleSection } from "./SampleSection";
import { ShapeSection } from "./ShapeSection";
import { SpotlightSection } from "./SpotlightSection";
import { StepSection } from "./StepSection";
import { TextSection } from "./TextSection";

function load(list: SceneNode[], selectId: string): void {
  __resetNodeIdForTests();
  const nodes: Record<string, SceneNode> = {};
  for (const n of list) nodes[n.id] = n;
  useEditorStore.getState().loadScene({
    rootIds: list.map((n) => n.id),
    nodes,
    docName: "T",
    sourceId: null,
    select: [selectId],
  });
}

const node = (id: string): SceneNode => useEditorStore.getState().nodes[id]!;

afterEach(cleanup);

// Section collapse now lives in the store (so it survives a section unmounting
// in the real app) instead of each section's local state, which means it also
// outlives a test. Reset it per test — otherwise a spec that opens Effects
// leaves it open and the next `openEffects()` click closes it instead.
beforeEach(() => {
  useEditorStore.setState({ sectionsOpen: { stroke: false, effects: false } });
});

describe("TextSection", () => {
  it("renders nothing for a non-text selection", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    load([r], r.id);
    const { container } = render(<TextSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("edits font size and alignment of a text node", () => {
    const t = makeText(
      { x: 0, y: 0, width: 120, height: 40 },
      { fontSize: 24, align: "left" }
    );
    load([t], t.id);
    render(<TextSection />);

    // Size is the first numeric field (Line height, Letter spacing, hex follow).
    const size = screen.getAllByRole("textbox")[0]!;
    fireEvent.change(size, { target: { value: "40" } });
    fireEvent.blur(size);
    expect((node(t.id) as TextNode).fontSize).toBe(40);

    fireEvent.click(screen.getByLabelText("Align center"));
    expect((node(t.id) as TextNode).align).toBe("center");
  });

  it("changes font weight via the weight select", () => {
    const t = makeText(
      { x: 0, y: 0, width: 120, height: 40 },
      { fontWeight: 500 }
    );
    load([t], t.id);
    render(<TextSection />);
    fireEvent.click(screen.getByLabelText("Font weight"));
    fireEvent.click(screen.getByRole("option", { name: "Bold" }));
    expect((node(t.id) as TextNode).fontWeight).toBe(700);
  });
});

describe("ShapeSection", () => {
  it("renders nothing for a rectangle", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    load([r], r.id);
    const { container } = render(<ShapeSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("edits polygon side count", () => {
    const p = makePolygon({ x: 0, y: 0, width: 50, height: 50 }, { sides: 3 });
    load([p], p.id);
    render(<ShapeSection />);
    const count = screen.getByRole("textbox");
    fireEvent.change(count, { target: { value: "6" } });
    fireEvent.blur(count);
    expect((node(p.id) as PolygonNode).sides).toBe(6);
  });

  it("edits star point count and inner ratio", () => {
    const s = makeStar(
      { x: 0, y: 0, width: 50, height: 50 },
      { pointCount: 5, innerRatio: 0.4 }
    );
    load([s], s.id);
    render(<ShapeSection />);
    const [count, ratio] = screen.getAllByRole("textbox");
    fireEvent.change(count!, { target: { value: "8" } });
    fireEvent.blur(count!);
    fireEvent.change(ratio!, { target: { value: "60" } });
    fireEvent.blur(ratio!);
    expect((node(s.id) as StarNode).pointCount).toBe(8);
    expect((node(s.id) as StarNode).innerRatio).toBeCloseTo(0.6);
  });

  it("toggles path closed", () => {
    const p = makePath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      false
    );
    load([p], p.id);
    render(<ShapeSection />);
    expect((node(p.id) as PathNode).closed).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((node(p.id) as PathNode).closed).toBe(true);
  });
});

describe("EffectsSection type picker", () => {
  it("adds a drop shadow and converts it to a layer blur", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    render(<EffectsSection />);

    fireEvent.click(screen.getByLabelText("Add effect"));
    expect(node(r.id).effects).toHaveLength(1);
    expect(node(r.id).effects[0]!.type).toBe("drop-shadow");

    fireEvent.click(screen.getByLabelText("Effect type"));
    fireEvent.click(screen.getByRole("option", { name: "Layer blur" }));
    expect(node(r.id).effects[0]!.type).toBe("layer-blur");
  });

  it("converts a drop shadow to an inner shadow", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    render(<EffectsSection />);
    fireEvent.click(screen.getByLabelText("Add effect"));
    fireEvent.click(screen.getByLabelText("Effect type"));
    fireEvent.click(screen.getByRole("option", { name: "Inner shadow" }));
    expect(node(r.id).effects[0]!.type).toBe("inner-shadow");
  });

  it("shows a spread field for drop shadows only", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    render(<EffectsSection />);
    fireEvent.click(screen.getByLabelText("Add effect"));
    // Drop shadow → spread ("S") present.
    expect(screen.getByText("S")).toBeInTheDocument();
    // Inner shadow → no spread.
    fireEvent.click(screen.getByLabelText("Effect type"));
    fireEvent.click(screen.getByRole("option", { name: "Inner shadow" }));
    expect(screen.queryByText("S")).toBeNull();
    // Layer blur → no spread either.
    fireEvent.click(screen.getByLabelText("Effect type"));
    fireEvent.click(screen.getByRole("option", { name: "Layer blur" }));
    expect(screen.queryByText("S")).toBeNull();
  });

  it("edits the drop shadow spread", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    render(<EffectsSection />);
    fireEvent.click(screen.getByLabelText("Add effect"));
    const spread = screen.getByText("S").parentElement!.querySelector("input")!;
    fireEvent.change(spread, { target: { value: "8" } });
    fireEvent.blur(spread);
    expect(node(r.id).effects[0]!.spread).toBe(8);
  });
});

describe("SampleSection", () => {
  it("renders nothing for a non-sample node", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    const { container } = render(<SampleSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("edits the blur amount of a sample region", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    r.sample = { mode: "blur", amount: 8 };
    load([r], r.id);
    render(<SampleSection />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.blur(input);
    expect(node(r.id).sample?.amount).toBe(20);
  });

  it("labels a pixelate region as cell size and edits it", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    r.sample = { mode: "pixelate", amount: 12 };
    load([r], r.id);
    render(<SampleSection />);
    expect(screen.getByText("Pixelate")).toBeInTheDocument();
    expect(screen.getByText("Cell size")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "16" } });
    fireEvent.blur(input);
    expect(node(r.id).sample?.amount).toBe(16);
  });
});

describe("EffectsSection sample row (Design mode)", () => {
  function blurNode(): SceneNode {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    r.fills = [];
    r.sample = { mode: "blur", amount: 8 };
    return r;
  }

  // Section starts collapsed; the count badge makes the header name "Effects 1".
  const openEffects = (): void => {
    fireEvent.click(screen.getByRole("button", { name: /Effects/ }));
  };

  it("surfaces a blur annotation as an editable effect row", () => {
    const r = blurNode();
    load([r], r.id);
    render(<EffectsSection />);
    openEffects();
    expect(screen.getByLabelText("Effect type")).toBeInTheDocument();
    const amount = screen.getByRole("textbox");
    fireEvent.change(amount, { target: { value: "20" } });
    fireEvent.blur(amount);
    expect(node(r.id).sample?.amount).toBe(20);
  });

  it("switches the sample mode and resets the amount to that mode's default", () => {
    const r = blurNode();
    load([r], r.id);
    render(<EffectsSection />);
    openEffects();
    fireEvent.click(screen.getByLabelText("Effect type"));
    fireEvent.click(screen.getByRole("option", { name: "Magnifier" }));
    expect(node(r.id).sample?.mode).toBe("magnify");
    expect(node(r.id).sample?.amount).toBe(2); // SAMPLE_DEFAULT_AMOUNT.magnify
  });

  it("toggles the sample's visibility via the eye button", () => {
    const r = blurNode();
    load([r], r.id);
    render(<EffectsSection />);
    openEffects();
    fireEvent.click(screen.getByLabelText("Hide effect"));
    expect(node(r.id).sample?.enabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Show effect"));
    expect(node(r.id).sample?.enabled).toBe(true);
  });

  it("removes the sample, clearing the annotation", () => {
    const r = blurNode();
    load([r], r.id);
    render(<EffectsSection />);
    openEffects();
    fireEvent.click(screen.getByLabelText("Remove effect"));
    expect(node(r.id).sample).toBeNull();
  });

  it("applies a sample to a plain shape by converting a shadow row", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    render(<EffectsSection />);
    fireEvent.click(screen.getByLabelText("Add effect")); // drop-shadow
    fireEvent.click(screen.getByLabelText("Effect type"));
    fireEvent.click(screen.getByRole("option", { name: "Pixelate" }));
    expect(node(r.id).effects).toHaveLength(0);
    expect(node(r.id).sample?.mode).toBe("pixelate");
  });

  it("converts a sample back into a shadow effect", () => {
    const r = blurNode();
    load([r], r.id);
    render(<EffectsSection />);
    openEffects();
    fireEvent.click(screen.getByLabelText("Effect type"));
    fireEvent.click(screen.getByRole("option", { name: "Inner shadow" }));
    expect(node(r.id).sample).toBeNull();
    expect(node(r.id).effects[0]?.type).toBe("inner-shadow");
  });

  it("offers sample options for area shapes (polygon) but not for text", () => {
    // Polygon is an area shape → a shadow row can convert to a sample.
    const p = makePolygon({ x: 0, y: 0, width: 40, height: 40 }, { sides: 5 });
    load([p], p.id);
    const { unmount } = render(<EffectsSection />);
    fireEvent.click(screen.getByLabelText("Add effect"));
    fireEvent.click(screen.getByLabelText("Effect type"));
    expect(screen.queryByRole("option", { name: "Pixelate" })).not.toBeNull();
    unmount();

    // Text has no fillable area to obscure → no sample options.
    const t = makeText({ x: 0, y: 0, width: 40, height: 20 });
    load([t], t.id);
    render(<EffectsSection />);
    fireEvent.click(screen.getByLabelText("Add effect"));
    fireEvent.click(screen.getByLabelText("Effect type"));
    expect(screen.queryByRole("option", { name: "Pixelate" })).toBeNull();
  });
});

describe("StepSection", () => {
  it("renders nothing for a non-step node", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    const { container } = render(<StepSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("edits the badge number", () => {
    const e = makeEllipse({ x: 0, y: 0, width: 40, height: 40 });
    e.step = { number: 2 };
    load([e], e.id);
    render(<StepSection />);
    expect(screen.getByText("Step")).toBeInTheDocument();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    expect(node(e.id).step?.number).toBe(5);
  });
});

describe("CalloutSection", () => {
  it("renders nothing for a non-callout node", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    const { container } = render(<CalloutSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("edits the tail angle", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 100, height: 60 });
    r.callout = { angle: 215, length: 44 };
    load([r], r.id);
    render(<CalloutSection />);
    expect(screen.getByText("Callout")).toBeInTheDocument();
    const angle = screen.getAllByRole("textbox")[0]!; // first field = angle
    fireEvent.change(angle, { target: { value: "90" } });
    fireEvent.blur(angle);
    expect(node(r.id).callout?.angle).toBe(90);
  });
});

describe("SpotlightSection", () => {
  function spot() {
    const r = makeRectangle({ x: 0, y: 0, width: 200, height: 150 });
    r.spotlight = makeSpotlight();
    return r;
  }

  it("renders nothing for a non-spotlight node", () => {
    const r = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([r], r.id);
    const { container } = render(<SpotlightSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("edits the dim as a percentage of opacity", () => {
    const r = spot();
    load([r], r.id);
    render(<SpotlightSection />);
    expect(screen.getByText("Spotlight")).toBeInTheDocument();
    const dim = screen.getByRole("textbox"); // the only number field
    expect(dim).toHaveValue("60"); // 0.6 → 60%
    fireEvent.change(dim, { target: { value: "40" } });
    fireEvent.blur(dim);
    expect(node(r.id).spotlight?.opacity).toBeCloseTo(0.4);
  });

  it("switches the tint via the swatch chips", () => {
    const r = spot();
    load([r], r.id);
    render(<SpotlightSection />);
    fireEvent.click(screen.getByLabelText("Light"));
    expect(node(r.id).spotlight?.color).toBe("#f5f7fa");
    expect(screen.getByLabelText("Light")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});

describe("MeasureSection", () => {
  function dimension() {
    const l = makeLine({ x: 100, y: 200, width: 600, height: 0 });
    l.measure = { caps: "tick", scale: 1, unit: "px" };
    return l;
  }

  it("renders nothing for a plain line", () => {
    const l = makeLine({ x: 0, y: 0, width: 40, height: 0 });
    load([l], l.id);
    const { container } = render(<MeasureSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("switches the cap style via the chips", () => {
    const l = dimension();
    load([l], l.id);
    render(<MeasureSection />);
    expect(screen.getByText("Measure")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Arrows"));
    expect(node(l.id).measure?.caps).toBe("arrow");
    expect(screen.getByLabelText("Arrows")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("edits the scale factor", () => {
    const l = dimension();
    load([l], l.id);
    render(<MeasureSection />);
    const scale = screen.getByRole("textbox"); // the only number field
    fireEvent.change(scale, { target: { value: "0.5" } });
    fireEvent.blur(scale);
    expect(node(l.id).measure?.scale).toBeCloseTo(0.5);
  });

  it("offers no length field — the line's endpoints are the measurement", () => {
    // A typable length would be a second source of truth that disagreed with
    // the line the moment either endpoint moved.
    const l = dimension();
    load([l], l.id);
    render(<MeasureSection />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    // It reports the raw reading instead, so a scaled dimension still says
    // what it measured on the capture.
    expect(screen.getByText("600 px on the capture")).toBeInTheDocument();
  });
});
