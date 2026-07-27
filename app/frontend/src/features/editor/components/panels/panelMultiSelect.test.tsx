import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useEditorStore } from "../../state/editorStore";
import {
  __resetNodeIdForTests,
  makeEllipse,
  makeLine,
  makePolygon,
  makeRectangle,
  makeShadow,
  makeSolidPaint,
  makeStar,
  makeStroke,
  makeText,
  type PolygonNode,
  type RectangleNode,
  type SceneNode,
  type StarNode,
  type TextNode,
} from "../../types";
import { AppearanceSection } from "./AppearanceSection";
import { CalloutSection } from "./CalloutSection";
import { CornersSection } from "./CornersSection";
import { EffectsSection } from "./EffectsSection";
import { FillSection } from "./FillSection";
import { LayoutSection } from "./LayoutSection";
import { MeasureSection } from "./MeasureSection";
import { PositionSection } from "./PositionSection";
import { SampleSection } from "./SampleSection";
import { ShapeSection } from "./ShapeSection";
import { StepSection } from "./StepSection";
import { StrokeSection } from "./StrokeSection";
import { TextSection } from "./TextSection";

/**
 * Workstream P3 — multi-select editing (Figma's "Mixed" + batch apply).
 *
 * These assert the two halves the panels are built from: a field **reads**
 * `Mixed` when the selection disagrees, and **writes** to the whole selection in
 * one undo step. `lib/multi.test.ts` covers the pure read primitives; this file
 * covers the wiring — which field, which store action, which nodes.
 */

function load(list: SceneNode[], select: string[]): void {
  __resetNodeIdForTests();
  const nodes: Record<string, SceneNode> = {};
  for (const n of list) nodes[n.id] = n;
  useEditorStore.getState().loadScene({
    rootIds: list.map((n) => n.id),
    nodes,
    docName: "T",
    sourceId: null,
    select,
  });
}

const node = (id: string): SceneNode => useEditorStore.getState().nodes[id]!;
const box = (i: number) => ({ x: i * 10, y: i * 10, width: 100, height: 80 });

/** Type into a text field and commit, the way the panel's fields commit. */
function type(el: Element, value: string): void {
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
}

afterEach(cleanup);

beforeEach(() => {
  useEditorStore.setState({ sectionsOpen: { stroke: false, effects: false } });
});

describe("PositionSection multi-select", () => {
  it("reads Mixed for disagreeing coordinates and aligns the selection on commit", () => {
    const a = makeRectangle({ x: 0, y: 0, width: 100, height: 80 });
    const b = makeRectangle({ x: 50, y: 0, width: 100, height: 80 });
    load([a, b], [a.id, b.id]);
    render(<PositionSection />);

    const [x] = screen.getAllByRole("textbox");
    expect(x).toHaveAttribute("placeholder", "Mixed");

    type(x!, "40");
    expect(node(a.id).x).toBe(40);
    expect(node(b.id).x).toBe(40);
  });

  it("shows a shared coordinate as a real value, not Mixed", () => {
    const a = makeRectangle({ x: 12, y: 0, width: 100, height: 80 });
    const b = makeRectangle({ x: 12, y: 0, width: 100, height: 80 });
    load([a, b], [a.id, b.id]);
    render(<PositionSection />);

    const [x] = screen.getAllByRole("textbox");
    expect(x).not.toHaveAttribute("placeholder");
    expect(x).toHaveValue("12");
  });

  it("batches rotation across the selection as one undo step", () => {
    const a = makeRectangle(box(0));
    const b = makeRectangle(box(1));
    load([a, b], [a.id, b.id]);
    render(<PositionSection />);

    const fields = screen.getAllByRole("textbox");
    type(fields[2]!, "30"); // X, Y, rotation
    expect(node(a.id).rotation).toBe(30);
    expect(node(b.id).rotation).toBe(30);

    useEditorStore.getState().undo();
    expect(node(a.id).rotation).toBe(0);
    expect(node(b.id).rotation).toBe(0);
  });

  it("unifies a split flip instead of flipping each node independently", () => {
    const a = { ...makeRectangle(box(0)), flipH: true } as SceneNode;
    const b = makeRectangle(box(1));
    load([a, b], [a.id, b.id]);
    render(<PositionSection />);

    const flip = screen.getByLabelText("Flip horizontal");
    // Split reads unpressed, so one press produces a state you can see.
    expect(flip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(flip);
    expect(node(a.id).flipH).toBe(true);
    expect(node(b.id).flipH).toBe(true);
  });
});

describe("LayoutSection multi-select", () => {
  it("resizes every selected node to the typed width", () => {
    const a = makeRectangle({ x: 0, y: 0, width: 100, height: 80 });
    const b = makeRectangle({ x: 0, y: 0, width: 40, height: 20 });
    load([a, b], [a.id, b.id]);
    render(<LayoutSection />);

    const [w] = screen.getAllByRole("textbox");
    expect(w).toHaveAttribute("placeholder", "Mixed");
    type(w!, "200");
    expect(node(a.id).width).toBe(200);
    expect(node(b.id).width).toBe(200);
  });

  it("keeps each node's own aspect ratio rather than the primary's", () => {
    // 100×80 (ratio 1.25) and 40×20 (ratio 2), both locked.
    const a = {
      ...makeRectangle({ x: 0, y: 0, width: 100, height: 80 }),
      lockAspect: true,
    } as SceneNode;
    const b = {
      ...makeRectangle({ x: 0, y: 0, width: 40, height: 20 }),
      lockAspect: true,
    } as SceneNode;
    load([a, b], [a.id, b.id]);
    render(<LayoutSection />);

    type(screen.getAllByRole("textbox")[0]!, "200");
    expect(node(a.id).height).toBe(160); // 200 / 1.25
    expect(node(b.id).height).toBe(100); // 200 / 2
  });
});

describe("AppearanceSection multi-select", () => {
  it("batches opacity and reads Mixed when it disagrees", () => {
    const a = { ...makeRectangle(box(0)), opacity: 1 } as SceneNode;
    const b = { ...makeRectangle(box(1)), opacity: 0.5 } as SceneNode;
    load([a, b], [a.id, b.id]);
    render(<AppearanceSection />);

    // Opacity is a slider with its percentage read out beside the label.
    expect(screen.getByText("Mixed")).toBeInTheDocument();
    const opacity = screen.getByRole("slider", { name: "Opacity" });
    // The slider commits on settle, not on every intermediate value.
    fireEvent.change(opacity, { target: { value: "20" } });
    fireEvent.pointerUp(opacity);
    expect(node(a.id).opacity).toBeCloseTo(0.2);
    expect(node(b.id).opacity).toBeCloseTo(0.2);
  });

  it("unifies a split visibility toggle", () => {
    const a = makeRectangle(box(0));
    const b = { ...makeRectangle(box(1)), visible: false } as SceneNode;
    load([a, b], [a.id, b.id]);
    render(<AppearanceSection />);

    fireEvent.click(screen.getByLabelText("Show"));
    expect(node(a.id).visible).toBe(true);
    expect(node(b.id).visible).toBe(true);
  });

});

describe("CornersSection multi-select", () => {
  it("writes corner radius to every radius-capable node in one step", () => {
    const a = makeRectangle(box(0));
    const b = makeRectangle(box(1));
    load([a, b], [a.id, b.id]);
    render(<CornersSection />);

    type(screen.getAllByRole("textbox")[0]!, "8");
    expect((node(a.id) as RectangleNode).cornerRadius).toBe(8);
    expect((node(b.id) as RectangleNode).cornerRadius).toBe(8);

    useEditorStore.getState().undo();
    expect((node(a.id) as RectangleNode).cornerRadius).toBe(0);
    expect((node(b.id) as RectangleNode).cornerRadius).toBe(0);
  });

  it("stays out of the way when nothing selected can carry a radius", () => {
    const a = makeLine({ x: 0, y: 0, width: 60, height: 0 });
    load([a], [a.id]);
    const { container } = render(<CornersSection />);
    expect(container.firstChild).toBeNull();
  });
});

describe("StrokeSection edit-by-index (Fork P-F1)", () => {
  // The section starts collapsed; the count badge makes the header "Stroke 2".
  const openStroke = (): void => {
    fireEvent.click(screen.getByRole("button", { name: /Stroke/ }));
  };

  function twoStroked(): { a: SceneNode; b: SceneNode } {
    const a = {
      ...makeRectangle(box(0)),
      strokes: [makeStroke("#111111", 1), makeStroke("#222222", 2)],
    } as SceneNode;
    const b = {
      ...makeRectangle(box(1)),
      strokes: [makeStroke("#333333", 5)],
    } as SceneNode;
    return { a, b };
  }

  it("writes row 0 to the same row of every selected node", () => {
    const { a, b } = twoStroked();
    load([a, b], [a.id, b.id]);
    render(<StrokeSection />);
    openStroke();

    // Row 0: hex, opacity, width.
    const width = screen.getAllByRole("textbox")[2]!;
    expect(width).toHaveAttribute("placeholder", "Mixed");
    type(width, "4");
    expect(node(a.id).strokes[0]!.width).toBe(4);
    expect(node(b.id).strokes[0]!.width).toBe(4);
  });

  it("skips a node with fewer strokes instead of inventing a row for it", () => {
    const { a, b } = twoStroked();
    load([a, b], [a.id, b.id]);
    render(<StrokeSection />);
    openStroke();

    // Row 1 exists only on the primary: hex, opacity, width per row → index 5.
    type(screen.getAllByRole("textbox")[5]!, "9");
    expect(node(a.id).strokes[1]!.width).toBe(9);
    expect(node(b.id).strokes).toHaveLength(1);
  });

  it("adds a stroke to every selected node", () => {
    const a = makeRectangle(box(0));
    const b = makeRectangle(box(1));
    load([a, b], [a.id, b.id]);
    render(<StrokeSection />);

    fireEvent.click(screen.getByLabelText("Add stroke"));
    expect(node(a.id).strokes).toHaveLength(1);
    expect(node(b.id).strokes).toHaveLength(1);
    // Each node gets its own entry, not a shared id.
    expect(node(a.id).strokes[0]!.id).not.toBe(node(b.id).strokes[0]!.id);
  });

  it("removes the row from every node that has one", () => {
    const { a, b } = twoStroked();
    load([a, b], [a.id, b.id]);
    render(<StrokeSection />);
    openStroke();

    fireEvent.click(screen.getAllByLabelText("Remove stroke")[0]!);
    expect(node(a.id).strokes).toHaveLength(1);
    expect(node(b.id).strokes).toHaveLength(0);
  });
});

describe("FillSection multi-select", () => {
  it("labels a row Mixed when the selection paints it differently", () => {
    const a = {
      ...makeRectangle(box(0)),
      fills: [makeSolidPaint("#ff0000")],
    } as SceneNode;
    const b = {
      ...makeRectangle(box(1)),
      fills: [makeSolidPaint("#00ff00")],
    } as SceneNode;
    load([a, b], [a.id, b.id]);
    render(<FillSection />);

    expect(screen.getByText("Mixed")).toBeTruthy();
  });

  it("shows the shared hex when the selection agrees", () => {
    const a = {
      ...makeRectangle(box(0)),
      fills: [makeSolidPaint("#ff0000")],
    } as SceneNode;
    const b = {
      ...makeRectangle(box(1)),
      fills: [makeSolidPaint("#ff0000")],
    } as SceneNode;
    load([a, b], [a.id, b.id]);
    render(<FillSection />);

    expect(screen.getByText("FF0000")).toBeTruthy();
    expect(screen.queryByText("Mixed")).toBeNull();
  });

  it("batches fill opacity across the selection", () => {
    const a = {
      ...makeRectangle(box(0)),
      fills: [makeSolidPaint("#ff0000")],
    } as SceneNode;
    const b = {
      ...makeRectangle(box(1)),
      fills: [makeSolidPaint("#ff0000")],
    } as SceneNode;
    load([a, b], [a.id, b.id]);
    render(<FillSection />);

    type(screen.getAllByRole("textbox")[0]!, "40");
    expect(node(a.id).fills[0]!.opacity).toBeCloseTo(0.4);
    expect(node(b.id).fills[0]!.opacity).toBeCloseTo(0.4);
  });
});

describe("EffectsSection multi-select", () => {
  it("batches a shadow's blur across the selection", () => {
    const a = {
      ...makeRectangle(box(0)),
      effects: [makeShadow()],
    } as SceneNode;
    const b = {
      ...makeRectangle(box(1)),
      effects: [makeShadow()],
    } as SceneNode;
    load([a, b], [a.id, b.id]);
    render(<EffectsSection />);
    fireEvent.click(screen.getByLabelText("Add effect"));
    // Re-render happened via the store; open the section to reach the fields.
    useEditorStore.setState({ sectionsOpen: { stroke: false, effects: true } });

    const fields = screen.getAllByRole("textbox");
    // Row 0: hex, X, Y, B, S.
    type(fields[3]!, "12");
    expect(node(a.id).effects[0]!.blur).toBe(12);
    expect(node(b.id).effects[0]!.blur).toBe(12);
  });
});

describe("CalloutSection multi-select", () => {
  const callout = (angle: number, length: number): SceneNode =>
    ({
      ...makeRectangle(box(0)),
      callout: { angle, length },
    }) as SceneNode;

  it("swings every selected callout's tail together", () => {
    const a = callout(0, 20);
    const b = callout(90, 40);
    load([a, b], [a.id, b.id]);
    render(<CalloutSection />);

    const [angle] = screen.getAllByRole("textbox");
    expect(angle).toHaveAttribute("placeholder", "Mixed");
    type(angle!, "45");
    expect(node(a.id).callout!.angle).toBe(45);
    expect(node(b.id).callout!.angle).toBe(45);
    // Each keeps its own length — the patch is per-node, not the primary's spec.
    expect(node(a.id).callout!.length).toBe(20);
    expect(node(b.id).callout!.length).toBe(40);
  });

  it("lets a non-callout in the selection sit out", () => {
    const a = callout(10, 20);
    const r = makeRectangle(box(1));
    load([a, r], [a.id, r.id]);
    render(<CalloutSection />);

    const [angle] = screen.getAllByRole("textbox");
    expect(angle).toHaveValue("10"); // not Mixed
    type(angle!, "70");
    expect(node(a.id).callout!.angle).toBe(70);
    expect(node(r.id).callout).toBeUndefined();
  });
});

describe("MeasureSection multi-select", () => {
  const dimension = (scale: number, unit: string): SceneNode =>
    ({
      ...makeLine({ x: 0, y: 0, width: 600, height: 0 }),
      measure: { caps: "tick" as const, scale, unit },
    }) as SceneNode;

  it("restyles every selected dimension together", () => {
    const a = dimension(1, "px");
    const b = dimension(2, "pt");
    load([a, b], [a.id, b.id]);
    render(<MeasureSection />);

    const [scale] = screen.getAllByRole("textbox");
    expect(scale).toHaveAttribute("placeholder", "Mixed");
    type(scale!, "0.5");
    expect(node(a.id).measure!.scale).toBeCloseTo(0.5);
    expect(node(b.id).measure!.scale).toBeCloseTo(0.5);
    // Each keeps its own unit — the patch is per-node, not the primary's spec.
    expect(node(a.id).measure!.unit).toBe("px");
    expect(node(b.id).measure!.unit).toBe("pt");
  });

  it("lets a non-measure in the selection sit out", () => {
    const a = dimension(1, "px");
    const r = makeRectangle(box(1));
    load([a, r], [a.id, r.id]);
    render(<MeasureSection />);

    fireEvent.click(screen.getByLabelText("Arrows"));
    expect(node(a.id).measure!.caps).toBe("arrow");
    expect(node(r.id).measure).toBeUndefined();
  });
});

describe("SampleSection multi-select", () => {
  const sample = (mode: "blur" | "pixelate", amount: number): SceneNode =>
    ({
      ...makeRectangle(box(0)),
      sample: { mode, amount, enabled: true },
    }) as SceneNode;

  it("adjusts every sample of the primary's mode at once", () => {
    const a = sample("blur", 4);
    const b = sample("blur", 10);
    load([a, b], [a.id, b.id]);
    render(<SampleSection />);

    const [amount] = screen.getAllByRole("textbox");
    expect(amount).toHaveAttribute("placeholder", "Mixed");
    type(amount!, "8");
    expect(node(a.id).sample!.amount).toBe(8);
    expect(node(b.id).sample!.amount).toBe(8);
  });

  it("leaves a different sample mode alone — the amount means another quantity", () => {
    const a = sample("blur", 4);
    const b = sample("pixelate", 12);
    load([a, b], [a.id, b.id]);
    render(<SampleSection />);

    const [amount] = screen.getAllByRole("textbox");
    expect(amount).toHaveValue("4"); // follows the primary's mode, not Mixed
    type(amount!, "9");
    expect(node(a.id).sample!.amount).toBe(9);
    expect(node(b.id).sample!.amount).toBe(12);
  });
});

describe("ShapeSection multi-select", () => {
  it("edits every polygon in the selection", () => {
    const a = makePolygon(box(0), { sides: 5 });
    const b = makePolygon(box(1), { sides: 8 });
    load([a, b], [a.id, b.id]);
    render(<ShapeSection />);

    const [sides] = screen.getAllByRole("textbox");
    expect(sides).toHaveAttribute("placeholder", "Mixed");
    type(sides!, "6");
    expect((node(a.id) as PolygonNode).sides).toBe(6);
    expect((node(b.id) as PolygonNode).sides).toBe(6);
  });

  it("groups by shape type — a star in the selection keeps its own params", () => {
    const a = makePolygon(box(0), { sides: 5 });
    const b = makeStar(box(1), { pointCount: 7 });
    load([a, b], [a.id, b.id]);
    render(<ShapeSection />);

    // The panel follows the primary (polygon); the star sits out entirely.
    type(screen.getAllByRole("textbox")[0]!, "9");
    expect((node(a.id) as PolygonNode).sides).toBe(9);
    expect((node(b.id) as StarNode).pointCount).toBe(7);
  });
});

describe("StepSection", () => {
  const badge = (n: number): SceneNode =>
    ({ ...makeEllipse(box(0)), step: { number: n } }) as SceneNode;

  it("edits the number for a single badge", () => {
    const a = badge(1);
    load([a], [a.id]);
    render(<StepSection />);
    type(screen.getAllByRole("textbox")[0]!, "4");
    expect(node(a.id).step!.number).toBe(4);
  });

  // The deliberate exception to P3: a badge's number is its place in a
  // sequence, so batching it would flatten 1·2·3 into one value.
  it("hides rather than batching when several badges are selected", () => {
    const a = badge(1);
    const b = badge(2);
    load([a, b], [a.id, b.id]);
    const { container } = render(<StepSection />);
    expect(container).toBeEmptyDOMElement();
    expect(node(a.id).step!.number).toBe(1);
    expect(node(b.id).step!.number).toBe(2);
  });
});

describe("TextSection multi-select", () => {
  it("appears for a mixed-type selection and edits only the text nodes", () => {
    const t1 = makeText(
      { x: 0, y: 0, width: 120, height: 40 },
      { fontSize: 24 }
    );
    const r = makeRectangle(box(1));
    const t2 = makeText(
      { x: 0, y: 0, width: 120, height: 40 },
      { fontSize: 24 }
    );
    load([t1, r, t2], [t1.id, r.id, t2.id]);
    render(<TextSection />);

    const size = screen.getAllByRole("textbox")[0]!;
    expect(size).toHaveValue("24"); // the rectangle sits out, so not Mixed
    type(size, "40");
    expect((node(t1.id) as TextNode).fontSize).toBe(40);
    expect((node(t2.id) as TextNode).fontSize).toBe(40);
    expect(node(r.id).type).toBe("rectangle");
  });

  it("reads Mixed when the text nodes disagree", () => {
    const t1 = makeText(
      { x: 0, y: 0, width: 120, height: 40 },
      { fontSize: 12 }
    );
    const t2 = makeText(
      { x: 0, y: 0, width: 120, height: 40 },
      { fontSize: 30 }
    );
    load([t1, t2], [t1.id, t2.id]);
    render(<TextSection />);

    expect(screen.getAllByRole("textbox")[0]!).toHaveAttribute(
      "placeholder",
      "Mixed"
    );
  });

  it("leaves every alignment button unpressed on a split selection", () => {
    const t1 = makeText(
      { x: 0, y: 0, width: 120, height: 40 },
      { align: "left" }
    );
    const t2 = makeText(
      { x: 0, y: 0, width: 120, height: 40 },
      { align: "right" }
    );
    load([t1, t2], [t1.id, t2.id]);
    render(<TextSection />);

    for (const label of ["Align left", "Align center", "Align right"]) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        "aria-pressed",
        "false"
      );
    }
  });
});
