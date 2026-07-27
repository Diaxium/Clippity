import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stampPreview } from "../../lib/stamps";
import { useEditorStore } from "../../state/editorStore";
import {
  __resetNodeIdForTests,
  makeRectangle,
  type RectangleNode,
  type SceneNode,
  type StampKind,
} from "../../types";
import { StampSection } from "./StampSection";

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

function stamp(kind: StampKind, name = "Check"): RectangleNode {
  const n = makeRectangle({ x: 0, y: 0, width: 48, height: 48 }, { name });
  n.stamp = { kind };
  return n;
}

const node = (id: string): SceneNode => useEditorStore.getState().nodes[id]!;

afterEach(cleanup);
beforeEach(() => useEditorStore.setState({ sectionsOpen: {} }));

describe("StampSection", () => {
  it("stays hidden with no stamp selected and the tool unarmed", () => {
    __resetNodeIdForTests();
    const plain = makeRectangle({ x: 0, y: 0, width: 40, height: 40 });
    load([plain], [plain.id]);
    const { container } = render(<StampSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("appears for the armed tool alone, so the first stamp can be chosen", () => {
    load([], []);
    useEditorStore.getState().setTool("stamp");
    render(<StampSection />);
    expect(screen.getByRole("heading", { name: "Stamp" })).toBeTruthy();
    // With nothing selected the grid reflects what the tool is armed with.
    expect(
      screen.getByRole("button", { name: "Check" }).getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("re-icons the selected stamp and renames the layer with it", () => {
    __resetNodeIdForTests();
    const s = stamp("check");
    load([s], [s.id]);
    render(<StampSection />);
    fireEvent.click(screen.getByRole("button", { name: "Warning" }));
    expect(node(s.id).stamp?.kind).toBe("warning");
    expect(node(s.id).name).toBe("Warning");
  });

  it("keeps a layer title the user typed", () => {
    __resetNodeIdForTests();
    const s = stamp("check", "Broken login");
    load([s], [s.id]);
    render(<StampSection />);
    fireEvent.click(screen.getByRole("button", { name: "Cross" }));
    expect(node(s.id).stamp?.kind).toBe("cross");
    expect(node(s.id).name).toBe("Broken login");
  });

  it("also arms the next stamp, so the tool keeps drawing the last choice", () => {
    __resetNodeIdForTests();
    const s = stamp("check");
    load([s], [s.id]);
    render(<StampSection />);
    fireEvent.click(screen.getByRole("button", { name: "Star" }));
    expect(useEditorStore.getState().stampKind).toBe("star");
  });

  it("shows nothing pressed for a selection that disagrees, and unifies on a pick", () => {
    __resetNodeIdForTests();
    const a = stamp("check");
    const b = stamp("heart", "Heart");
    load([a, b], [a.id, b.id]);
    render(<StampSection />);
    for (const label of ["Check", "Heart"]) {
      expect(
        screen.getByRole("button", { name: label }).getAttribute("aria-pressed")
      ).toBe("false");
    }
    fireEvent.click(screen.getByRole("button", { name: "Flag" }));
    expect(node(a.id).stamp?.kind).toBe("flag");
    expect(node(b.id).stamp?.kind).toBe("flag");
    // Edit-by-node: each layer's rename is decided from *its own* old icon, so
    // both untouched titles follow along.
    expect(node(a.id).name).toBe("Flag");
    expect(node(b.id).name).toBe("Flag");
  });

  it("re-icons only the stamps in a mixed marquee", () => {
    __resetNodeIdForTests();
    const s = stamp("check");
    const plain = makeRectangle({ x: 0, y: 0, width: 10, height: 10 });
    load([s, plain], [s.id, plain.id]);
    render(<StampSection />);
    fireEvent.click(screen.getByRole("button", { name: "Lock" }));
    expect(node(s.id).stamp?.kind).toBe("lock");
    expect(node(plain.id).stamp).toBeUndefined();
  });

  it("batches the whole selection into one undo step", () => {
    __resetNodeIdForTests();
    const a = stamp("check");
    const b = stamp("check");
    load([a, b], [a.id, b.id]);
    render(<StampSection />);
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    act(() => useEditorStore.getState().undo());
    expect(node(a.id).stamp?.kind).toBe("check");
    expect(node(b.id).stamp?.kind).toBe("check");
  });

  it("previews each icon with the very path data the canvas paints", () => {
    __resetNodeIdForTests();
    const s = stamp("check");
    load([s], [s.id]);
    const { container } = render(<StampSection />);
    const star = stampPreview("star", 24);
    const ds = Array.from(container.querySelectorAll("path")).map((p) =>
      p.getAttribute("d")
    );
    expect(ds).toContain(star.fillD);
  });
});
