import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetNodeIdForTests,
  makeFrame,
  makeImage,
  makeRectangle,
  type RectangleNode,
} from "../types";
import { useEditorStore } from "../state/editorStore";
import { DockDropZone, FloatingInspector } from "./FloatingInspector";
import { InspectorPanel } from "./InspectorPanel";
import { InspectorSections } from "./InspectorSections";
import { ColorPopover } from "./ColorPopover";
import { EditorContextMenu } from "./EditorContextMenu";
import { EditorDocTitle } from "./EditorDocTitle";
import { EditorTopBar } from "./EditorTopBar";
import { LeftPanel } from "./LeftPanel";

function seed(): { frameId: string; rect: RectangleNode } {
  __resetNodeIdForTests();
  const frame = makeFrame(
    { x: 0, y: 0, width: 200, height: 150 },
    { name: "Image 1" }
  );
  const rect = makeRectangle(
    { x: 20, y: 30, width: 80, height: 60 },
    { name: "Rectangle" }
  );
  frame.children = [rect.id];
  useEditorStore.getState().loadScene({
    rootIds: [frame.id],
    nodes: { [frame.id]: frame, [rect.id]: rect },
    docName: "Image 1",
    sourceId: null,
  });
  return { frameId: frame.id, rect };
}

const state = () => useEditorStore.getState();

/** Move the inspector to a tab. Geometry lives under Arrange and the read-only
 *  readout under Inspect, so a spec about either has to say so — the default is
 *  Style. Set through the store rather than by clicking, so it works for the
 *  specs that render `InspectorSections` without its tab strip. */
const showTab = (tab: "style" | "arrange" | "inspect") =>
  act(() => state().setInspectorTab(tab));

afterEach(cleanup);

// Inspector chrome (dock side, collapse, drop-zone preview) lives in the store
// so it survives a remount in the real app — which means it also survives a
// test. Reset it per test, or a spec that docks a panel leaks into the next
// one's assertions about the defaults.
beforeEach(() => {
  useEditorStore.setState({
    inspectorDock: { annotate: null, design: "right" },
    dockPreview: null,
    inspectorTab: "style",
    sectionsOpen: { stroke: false, effects: false },
  });
});

describe("EditorTopBar wiring", () => {
  it("switches the active tool when a tool button is clicked", () => {
    seed();
    render(<EditorTopBar />);
    fireEvent.click(screen.getByTitle(/Rectangle/));
    expect(state().tool).toBe("rectangle");
    fireEvent.click(screen.getByTitle(/Text/));
    expect(state().tool).toBe("text");
  });

  /** Open the toolbar's single trailing tool menu and pick a tool from it.
   *  Groups no longer carry their own caret — see `ToolOverflow`. */
  const pickFromOverflow = (name: RegExp) => {
    fireEvent.click(screen.getByLabelText("All tools"));
    fireEvent.click(screen.getByRole("menuitemradio", { name }));
  };

  it("picks a sub-tool from the tool menu and updates the group primary", () => {
    seed();
    render(<EditorTopBar />);
    // Polygon is a Design-mode tool — switch modes first.
    fireEvent.click(screen.getByRole("radio", { name: "Design mode" }));
    // Shape group's primary defaults to Rectangle.
    expect(screen.getByTitle(/Rectangle/)).toBeInTheDocument();
    pickFromOverflow(/Polygon/);
    expect(state().tool).toBe("polygon");
    // The group's button now shows the chosen sub-tool.
    expect(screen.getByTitle(/Polygon/)).toBeInTheDocument();
  });

  it("groups Move + Hand under the pointer group", () => {
    seed();
    render(<EditorTopBar />);
    pickFromOverflow(/Hand tool/);
    expect(state().tool).toBe("hand");
  });

  it("leads with an annotate group and selects the magnifier from it", () => {
    seed();
    render(<EditorTopBar />);
    // Annotate group's primary defaults to Blur.
    expect(screen.getByTitle(/Blur/)).toBeInTheDocument();
    pickFromOverflow(/Magnifier/);
    expect(state().tool).toBe("magnify");
  });

  it("offers the highlight tool in the annotate group", () => {
    seed();
    render(<EditorTopBar />);
    pickFromOverflow(/Highlight/);
    expect(state().tool).toBe("highlight");
  });

  it("offers the pixelate tool in the annotate group", () => {
    seed();
    render(<EditorTopBar />);
    pickFromOverflow(/Pixelate/);
    expect(state().tool).toBe("pixelate");
  });

  it("offers the step tool in the annotate group", () => {
    seed();
    render(<EditorTopBar />);
    pickFromOverflow(/Step/);
    expect(state().tool).toBe("step");
  });

  it("offers the callout tool in the annotate group", () => {
    seed();
    render(<EditorTopBar />);
    pickFromOverflow(/Callout/);
    expect(state().tool).toBe("callout");
  });

  it("filters the toolbar by mode and toggles via the mode switch", () => {
    seed();
    render(<EditorTopBar />);
    // Default Annotation mode: Blur present, Pen group absent.
    expect(screen.getByTitle(/Blur/)).toBeInTheDocument();
    expect(screen.queryByTitle(/^Pen/)).toBeNull();
    // Switch to Design: Blur gone, Pen group present.
    fireEvent.click(screen.getByRole("radio", { name: "Design mode" }));
    expect(state().mode).toBe("design");
    expect(screen.queryByTitle(/Blur/)).toBeNull();
    expect(screen.getByTitle(/^Pen/)).toBeInTheDocument();
  });
});

describe("LeftPanel / LayersTree wiring", () => {
  it("renders the seeded layers and selects on row click", () => {
    const { rect } = seed();
    render(<LeftPanel />);
    expect(screen.getByText("Image 1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Rectangle"));
    expect(state().selectedIds).toEqual([rect.id]);
  });
});

describe("InspectorPanel / Design wiring", () => {
  it("shows Position + Layout sections and edits a field", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setMode("design");
    showTab("arrange"); // Position/Layout live under Arrange
    render(<InspectorPanel mode="design" side="right" />);

    // Transform is split into Position (X/Y, rotation) and Layout (W/H).
    expect(
      screen.getByRole("heading", { name: "Position" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Layout" })).toBeInTheDocument();

    // X field shows the node's x; editing + blur commits to the store.
    const xField = screen.getByDisplayValue("20");
    fireEvent.change(xField, { target: { value: "50" } });
    fireEvent.blur(xField);
    expect(state().nodes[rect.id]!.x).toBe(50);
  });

  it("prompts to select a layer when nothing is selected", () => {
    seed();
    state().clearSelection();
    state().setMode("design");
    render(<InspectorPanel mode="design" side="right" />);
    expect(screen.getByText(/Select a layer/i)).toBeInTheDocument();
  });
});

describe("EditorDocTitle wiring", () => {
  it("edits the document name", () => {
    seed();
    render(<EditorDocTitle />);
    fireEvent.click(screen.getByText("Image 1"));
    const input = screen.getByDisplayValue("Image 1");
    fireEvent.change(input, { target: { value: "Hero shot" } });
    fireEvent.blur(input);
    expect(state().docName).toBe("Hero shot");
  });
});

describe("FrameSection lock aspect", () => {
  it("locks aspect and scales the other dimension proportionally", () => {
    const { rect } = seed(); // rect is 80×60 (ratio 4:3)
    state().select([rect.id]);
    state().setMode("design");
    showTab("arrange"); // Layout (W/H) lives under Arrange
    render(<InspectorPanel mode="design" side="right" />);

    fireEvent.click(screen.getByRole("button", { name: /lock aspect ratio/i }));
    expect(state().nodes[rect.id]!.lockAspect).toBe(true);

    const wField = screen.getByDisplayValue("80");
    fireEvent.change(wField, { target: { value: "160" } });
    fireEvent.blur(wField);
    expect(state().nodes[rect.id]!.width).toBe(160);
    expect(state().nodes[rect.id]!.height).toBe(120);
  });
});

describe("Collapsible advanced sections", () => {
  it("starts collapsed and toggles open", () => {
    const { rect } = seed();
    state().select([rect.id]);
    render(<InspectorPanel mode="design" side="right" />);
    const stroke = screen.getByRole("button", { name: "Stroke" });
    expect(stroke).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(stroke);
    expect(stroke).toHaveAttribute("aria-expanded", "true");
  });
});

describe("LayersTree rename via context menu", () => {
  it("enters inline edit when a rename is requested", () => {
    const { rect } = seed();
    render(<LeftPanel />);
    expect(screen.getByText("Rectangle")).toBeInTheDocument();
    act(() => state().requestRename(rect.id));
    expect(screen.getByDisplayValue("Rectangle")).toBeInTheDocument();
  });
});

describe("EditorContextMenu node actions", () => {
  it("offers rename + export for a single selection and wires rename", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().openContextMenu({
      x: 10,
      y: 10,
      sceneX: 0,
      sceneY: 0,
      kind: "node",
    });
    render(<EditorContextMenu />);

    expect(screen.getByText("Rename")).toBeInTheDocument();
    expect(screen.getByText("Export")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Rename"));
    expect(state().renamingId).toBe(rect.id);
  });
});

describe("PositionSection flip", () => {
  it("toggles flip horizontal/vertical on the selection", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setMode("design");
    showTab("arrange"); // PositionSection (flip) lives under Arrange
    render(<InspectorPanel mode="design" side="right" />);

    fireEvent.click(screen.getByLabelText("Flip horizontal"));
    expect(state().nodes[rect.id]!.flipH).toBe(true);
    fireEvent.click(screen.getByLabelText("Flip vertical"));
    expect(state().nodes[rect.id]!.flipV).toBe(true);
    fireEvent.click(screen.getByLabelText("Flip horizontal"));
    expect(state().nodes[rect.id]!.flipH).toBe(false);
  });
});

describe("AppearanceSection corner radii", () => {
  it("toggles independent corners on and off", () => {
    const { rect } = seed();
    state().select([rect.id]);
    render(<InspectorPanel mode="design" side="right" />);

    expect((state().nodes[rect.id] as RectangleNode).cornerRadii).toBeNull();
    fireEvent.click(screen.getByLabelText("Independent corners"));
    expect(
      (state().nodes[rect.id] as RectangleNode).cornerRadii
    ).not.toBeNull();
    fireEvent.click(screen.getByLabelText("Independent corners"));
    expect((state().nodes[rect.id] as RectangleNode).cornerRadii).toBeNull();
  });
});

describe("FillSection picker", () => {
  it("switches a fill between solid, gradient, and back", () => {
    const { rect } = seed();
    state().select([rect.id]);
    render(
      <>
        <InspectorPanel mode="design" side="right" />
        <ColorPopover />
      </>
    );

    fireEvent.click(screen.getByLabelText("Edit fill"));
    fireEvent.click(screen.getByRole("button", { name: "Gradient" }));
    const fill = state().nodes[rect.id]!.fills[0]!;
    expect(fill.type).toBe("gradient");
    expect(fill.gradient?.stops.length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Solid" }));
    expect(state().nodes[rect.id]!.fills[0]!.type).toBe("solid");
  });

  it("adds and removes gradient stops", () => {
    const { rect } = seed();
    state().select([rect.id]);
    render(
      <>
        <InspectorPanel mode="design" side="right" />
        <ColorPopover />
      </>
    );

    fireEvent.click(screen.getByLabelText("Edit fill"));
    fireEvent.click(screen.getByRole("button", { name: "Gradient" }));
    fireEvent.click(screen.getByLabelText("Add stop"));
    expect(state().nodes[rect.id]!.fills[0]!.gradient?.stops.length).toBe(3);

    fireEvent.click(screen.getAllByLabelText("Remove stop")[0]!);
    expect(state().nodes[rect.id]!.fills[0]!.gradient?.stops.length).toBe(2);
  });
});

describe("FillSection image node", () => {
  it("shows the image node's bitmap as an image fill", () => {
    __resetNodeIdForTests();
    const img = makeImage(
      { x: 0, y: 0, width: 200, height: 100 },
      "data:image/png;base64,AAA",
      {
        name: "Photo",
      }
    );
    useEditorStore.getState().loadScene({
      rootIds: [img.id],
      nodes: { [img.id]: img },
      docName: "Photo",
      sourceId: null,
    });
    state().select([img.id]);
    render(<InspectorPanel mode="design" side="right" />);
    expect(screen.getByLabelText("Edit fill")).toBeInTheDocument();
    expect(screen.getByText("Image")).toBeInTheDocument();
  });
});

describe("Inspector mode curation", () => {
  it("hides Effects from the Annotation-mode Style tab", () => {
    const { rect } = seed();
    state().select([rect.id]);
    render(<InspectorSections mode="annotate" />);
    expect(screen.queryByRole("heading", { name: "Effects" })).toBeNull();
    // Curated essentials still show.
    expect(screen.getByRole("heading", { name: "Fill" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Appearance" })
    ).toBeInTheDocument();
  });

  it("shows Effects in the Design-mode Style tab", () => {
    const { rect } = seed();
    state().select([rect.id]);
    render(<InspectorSections mode="design" />);
    expect(
      screen.getByRole("heading", { name: "Effects" })
    ).toBeInTheDocument();
    // Geometry moved to its own tab and is no longer in Style.
    expect(screen.queryByRole("heading", { name: "Position" })).toBeNull();
  });

  it("puts geometry under Arrange in both modes", () => {
    const { rect } = seed();
    state().select([rect.id]);
    showTab("arrange");
    render(<InspectorSections mode="annotate" />);
    expect(
      screen.getByRole("heading", { name: "Position" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Layout" })).toBeInTheDocument();
  });

  it("reports measurements read-only under Inspect", () => {
    const { rect } = seed(); // 80×60 at (20,30)
    state().select([rect.id]);
    showTab("inspect");
    render(<InspectorSections mode="design" />);
    expect(
      screen.getByRole("heading", { name: "Measurements" })
    ).toBeInTheDocument();
    expect(screen.getByText("80 × 60")).toBeInTheDocument();
    expect(screen.getByText("20, 30")).toBeInTheDocument();
  });
});

describe("InspectorPanel (docked rail)", () => {
  it("heads the rail with the selection and its measured size", () => {
    const { rect } = seed(); // "Rectangle", 80×60
    state().select([rect.id]);
    state().setMode("design");
    render(<InspectorPanel mode="design" side="right" />);
    expect(screen.getByText("Rectangle")).toBeInTheDocument();
    expect(screen.getByText(/Rectangle\s*•\s*80 × 60/)).toBeInTheDocument();
    // …and the three property tabs beneath it.
    expect(screen.getByRole("tab", { name: "Style" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Arrange" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Inspect" })).toBeInTheDocument();
  });

  it("switches tabs from the strip", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setMode("design");
    render(<InspectorPanel mode="design" side="right" />);
    expect(screen.queryByRole("heading", { name: "Position" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Arrange" }));
    expect(
      screen.getByRole("heading", { name: "Position" })
    ).toBeInTheDocument();
  });

  it("hides the tab strip with nothing selected", () => {
    seed();
    state().clearSelection();
    state().setMode("design");
    render(<InspectorPanel mode="design" side="right" />);
    expect(screen.queryByRole("tab", { name: "Style" })).toBeNull();
    expect(screen.getByText("Design")).toBeInTheDocument();
  });

  it("exposes a resize handle so the rail is no longer a fixed width", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setMode("design");
    render(<InspectorPanel mode="design" side="right" />);
    expect(
      screen.getByRole("separator", { name: "Resize inspector" })
    ).toBeInTheDocument();
  });

  it("carries Export as a Style section, not as a tab of its own", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setMode("design");
    render(<InspectorPanel mode="design" side="right" />);
    expect(screen.queryByRole("tab", { name: "Export" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Export" })).toBeInTheDocument();
  });
});

describe("FloatingInspector", () => {
  it("renders nothing without a selection", () => {
    seed();
    state().clearSelection();
    const { container } = render(<FloatingInspector mode="annotate" />);
    expect(container.querySelector("[data-floating-inspector]")).toBeNull();
  });

  it("floats the curated annotate sections beside a selection", () => {
    const { rect } = seed(); // default mode = annotate
    state().select([rect.id]);
    state().setCanvasSize(1200, 800);
    render(<FloatingInspector mode="annotate" />);
    expect(
      screen.getByRole("group", { name: "Inspector" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Fill" })).toBeInTheDocument();
    // Design-only sections stay out of the annotate surface.
    expect(screen.queryByRole("heading", { name: "Position" })).toBeNull();
  });

  it("dismisses on close, and a new selection brings it back", () => {
    const { rect, frameId } = seed();
    state().select([rect.id]);
    state().setCanvasSize(1200, 800);
    const { rerender } = render(<FloatingInspector mode="annotate" />);
    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(screen.queryByRole("group", { name: "Inspector" })).toBeNull();

    act(() => state().select([frameId]));
    rerender(<FloatingInspector mode="annotate" />);
    expect(
      screen.getByRole("group", { name: "Inspector" })
    ).toBeInTheDocument();
  });
});

describe("EditorTopBar export menu", () => {
  it("opens the export options from the top bar in Annotation mode", () => {
    seed(); // default mode = annotate — the mode that no longer has a rail
    render(<EditorTopBar />);
    // The Export face exports straight away; the caret beside it has the
    // format/scale options.
    fireEvent.click(screen.getByRole("button", { name: "Export options" }));
    expect(screen.getByRole("heading", { name: "Export" })).toBeInTheDocument();
  });

  it("Mod+Shift+E (exportRequest) reveals the menu", () => {
    seed();
    render(<EditorTopBar />);
    expect(screen.queryByRole("heading", { name: "Export" })).toBeNull();
    act(() => state().requestExport());
    expect(screen.getByRole("heading", { name: "Export" })).toBeInTheDocument();
  });
});

describe("inspector docking", () => {
  /** Pointer sequence over an element, in client coords. */
  const dragTo = (el: Element, fromX: number, toX: number): void => {
    fireEvent.pointerDown(el, { pointerId: 1, clientX: fromX, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: toX, clientY: 100 });
    fireEvent.pointerUp(el, { pointerId: 1, clientX: toX, clientY: 100 });
  };

  it("defaults Annotation to floating and Design to a right rail", () => {
    seed();
    expect(state().inspectorDock.annotate).toBeNull();
    expect(state().inspectorDock.design).toBe("right");
  });

  it("docks a floating panel dropped near an edge", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setCanvasSize(1200, 800);
    render(<FloatingInspector mode="annotate" />);

    // jsdom gives the canvas-area lookup a zero rect, so the workspace falls
    // back to the window — drop just inside its right edge.
    const header = screen.getByRole("group", {
      name: "Inspector",
    }).firstElementChild!;
    dragTo(header, 600, window.innerWidth - 4);

    expect(state().inspectorDock.annotate).toBe("right");
    // The drag is over, so the drop-zone highlight must not linger.
    expect(state().dockPreview).toBeNull();
  });

  it("leaves a panel floating when dropped in the middle", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setCanvasSize(1200, 800);
    render(<FloatingInspector mode="annotate" />);

    const header = screen.getByRole("group", {
      name: "Inspector",
    }).firstElementChild!;
    dragTo(header, 600, Math.round(window.innerWidth / 2));

    expect(state().inspectorDock.annotate).toBeNull();
    expect(state().dockPreview).toBeNull();
  });

  it("previews the target edge mid-drag, before release", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setCanvasSize(1200, 800);
    render(<FloatingInspector mode="annotate" />);

    const header = screen.getByRole("group", {
      name: "Inspector",
    }).firstElementChild!;
    fireEvent.pointerDown(header, { pointerId: 1, clientX: 600, clientY: 100 });
    fireEvent.pointerMove(header, {
      pointerId: 1,
      clientX: window.innerWidth - 4,
      clientY: 100,
    });
    expect(state().dockPreview).toBe("right");
    // Still floating — the preview is not a commitment.
    expect(state().inspectorDock.annotate).toBeNull();
  });

  it("undocks a rail pulled inward past the threshold", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setMode("design");
    render(<InspectorPanel mode="design" side="right" />);

    const grip = screen.getByRole("button", { name: "Undock inspector" });
    dragTo(grip, 1400, 1400 - 200);
    expect(state().inspectorDock.design).toBeNull();
  });

  it("keeps a rail docked when the pull is too small", () => {
    const { rect } = seed();
    state().select([rect.id]);
    state().setMode("design");
    render(<InspectorPanel mode="design" side="right" />);

    const grip = screen.getByRole("button", { name: "Undock inspector" });
    dragTo(grip, 1400, 1400 - 10);
    expect(state().inspectorDock.design).toBe("right");
  });

  it("renders the drop-zone highlight only while a target is previewed", () => {
    seed();
    const { container, rerender } = render(<DockDropZone />);
    expect(container.querySelector("[data-dock-drop-zone]")).toBeNull();

    act(() => state().setDockPreview("left"));
    rerender(<DockDropZone />);
    expect(
      container.querySelector('[data-dock-drop-zone="left"]')
    ).not.toBeNull();
  });

  it("docks each mode independently", () => {
    seed();
    act(() => state().setInspectorDock("annotate", "left"));
    expect(state().inspectorDock.annotate).toBe("left");
    // Design is untouched by the other mode's docking.
    expect(state().inspectorDock.design).toBe("right");
  });
});
