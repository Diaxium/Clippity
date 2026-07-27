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
} from "../../types";
import {
  DEFAULT_CONTENT_RADIUS,
  DEFAULT_PAGE_PADDING,
  hasContentShadow,
  matchBackdropPreset,
  pagePadding,
} from "../../lib/page";
import { unionBounds } from "../../geometry";
import { useEditorStore } from "../../state/editorStore";
import { BackdropSection } from "./BackdropSection";

const PAGE = { x: 0, y: 0, width: 400, height: 300 };

/** The shape `sceneFromImage` builds, plus an annotation drawn on the capture. */
function seed(): { pageId: string; photoId: string; markId: string } {
  __resetNodeIdForTests();
  const frame = makeFrame(PAGE, { name: "Page" });
  const photo = makeImage(PAGE, "data:image/png;base64,AA", { name: "Photo" });
  const mark = makeRectangle(
    { x: 20, y: 20, width: 60, height: 40 },
    { name: "Mark" }
  );
  frame.children = [photo.id, mark.id];
  useEditorStore.getState().loadScene({
    rootIds: [frame.id],
    nodes: { [frame.id]: frame, [photo.id]: photo, [mark.id]: mark },
    docName: "Page",
    sourceId: null,
  });
  return { pageId: frame.id, photoId: photo.id, markId: mark.id };
}

const state = () => useEditorStore.getState();
const page = (id: string) => state().nodes[id]!;

afterEach(cleanup);
beforeEach(() => useEditorStore.setState({ sectionsOpen: {} }));

describe("BackdropSection scoping", () => {
  it("shows on an empty selection — that is how you address the page", () => {
    seed();
    state().clearSelection();
    render(<BackdropSection />);
    expect(
      screen.getByRole("heading", { name: "Backdrop" })
    ).toBeInTheDocument();
  });

  it("shows when the page frame itself is selected", () => {
    const { pageId } = seed();
    state().select([pageId]);
    render(<BackdropSection />);
    expect(
      screen.getByRole("heading", { name: "Backdrop" })
    ).toBeInTheDocument();
  });

  it("hides while a mark is selected", () => {
    const { markId } = seed();
    state().select([markId]);
    render(<BackdropSection />);
    expect(screen.queryByRole("heading", { name: "Backdrop" })).toBeNull();
  });

  it("hides on a document with no capture to pad", () => {
    __resetNodeIdForTests();
    const frame = makeFrame(PAGE, { name: "Page" });
    useEditorStore.getState().loadScene({
      rootIds: [frame.id],
      nodes: { [frame.id]: frame },
      docName: "Page",
      sourceId: null,
    });
    state().clearSelection();
    render(<BackdropSection />);
    expect(screen.queryByRole("heading", { name: "Backdrop" })).toBeNull();
  });
});

describe("BackdropSection wiring", () => {
  it("applies a preset, and opens a margin so it is actually visible", () => {
    const { pageId, photoId } = seed();
    state().clearSelection();
    render(<BackdropSection />);

    fireEvent.click(screen.getByRole("button", { name: "Violet" }));

    expect(matchBackdropPreset(page(pageId).fills)).toBe("violet");
    expect(pagePadding(page(pageId), PAGE)).toBe(DEFAULT_PAGE_PADDING);
    const photo = page(photoId);
    expect(photo.type === "image" && photo.cornerRadius).toBe(
      DEFAULT_CONTENT_RADIUS
    );
  });

  it("bundles the preset + margin into one undo step", () => {
    const { pageId } = seed();
    state().clearSelection();
    render(<BackdropSection />);

    fireEvent.click(screen.getByRole("button", { name: "Sunset" }));
    act(() => state().undo());

    expect(page(pageId).fills).toHaveLength(0);
    expect(pagePadding(page(pageId), PAGE)).toBe(0);
  });

  it("keeps the padding the user already chose when applying a preset", () => {
    const { pageId } = seed();
    state().clearSelection();
    state().setPagePadding(120);
    render(<BackdropSection />);

    fireEvent.click(screen.getByRole("button", { name: "Mint" }));

    expect(pagePadding(page(pageId), PAGE)).toBe(120);
  });

  it("None clears the backdrop without disturbing the margin", () => {
    const { pageId } = seed();
    state().clearSelection();
    render(<BackdropSection />);

    fireEvent.click(screen.getByRole("button", { name: "Violet" }));
    fireEvent.click(screen.getByRole("button", { name: "None" }));

    expect(page(pageId).fills).toHaveLength(0);
    expect(pagePadding(page(pageId), PAGE)).toBe(DEFAULT_PAGE_PADDING);
  });

  it("marks the active preset pressed, and drops it once edited", () => {
    const { pageId } = seed();
    state().clearSelection();
    const { rerender } = render(<BackdropSection />);

    fireEvent.click(screen.getByRole("button", { name: "Slate" }));
    rerender(<BackdropSection />);
    expect(screen.getByRole("button", { name: "Slate" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Edit the backdrop the way the Fill popover would.
    const fill = page(pageId).fills[0]!;
    act(() => state().updateFill(pageId, fill.id, { color: "#ff0000" }));
    rerender(<BackdropSection />);
    expect(screen.getByRole("button", { name: "Slate" })).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("toggles the capture's lift shadow", () => {
    const { photoId } = seed();
    state().clearSelection();
    render(<BackdropSection />);

    const toggle = screen.getByRole("checkbox", { name: "Shadow" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(hasContentShadow(page(photoId))).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Shadow" }));
    expect(hasContentShadow(page(photoId))).toBe(false);
  });
});

describe("page padding actions", () => {
  it("padding is the page frame's rect — the same edit crop makes", () => {
    const { pageId, photoId } = seed();
    state().setPagePadding(40);

    const p = page(pageId);
    expect({ x: p.x, y: p.y, width: p.width, height: p.height }).toEqual({
      x: -40,
      y: -40,
      width: 480,
      height: 380,
    });
    // Non-destructive: the capture never moves or resizes.
    const photo = page(photoId);
    expect({ x: photo.x, y: photo.y, width: photo.width }).toEqual({
      x: 0,
      y: 0,
      width: 400,
    });
  });

  it("padding survives a round trip through undo", () => {
    const { pageId } = seed();
    state().setPagePadding(64);
    expect(pagePadding(page(pageId), PAGE)).toBe(64);
    state().undo();
    expect(pagePadding(page(pageId), PAGE)).toBe(0);
    state().redo();
    expect(pagePadding(page(pageId), PAGE)).toBe(64);
  });

  it("stays inert when the backmost root is not a frame", () => {
    // Same guard crop uses: no page frame means no well-defined page.
    __resetNodeIdForTests();
    const photo = makeImage(PAGE, "data:image/png;base64,AA");
    useEditorStore.getState().loadScene({
      rootIds: [photo.id],
      nodes: { [photo.id]: photo },
      docName: "Photo",
      sourceId: null,
    });
    const before = state().nodes[photo.id];
    state().setPagePadding(40);
    state().applyBackdrop("violet");
    state().setContentShadow(true);
    expect(state().nodes[photo.id]).toBe(before);
  });

  it("grows the export region, so the backdrop reaches the saved image", () => {
    // The load-bearing claim. `flattenScene` sizes the output bitmap from
    // `unionBounds` of the **root** nodes (the same rule ADR 0019 leans on to
    // make crop reach the export), so asserting the union here asserts the
    // exported extent without needing a Canvas2D context jsdom doesn't have.
    const { pageId } = seed();
    state().applyBackdrop("violet");

    const roots = state().rootIds.map((id) => state().nodes[id]!);
    expect(unionBounds(roots)).toEqual({
      x: -DEFAULT_PAGE_PADDING,
      y: -DEFAULT_PAGE_PADDING,
      width: 400 + 2 * DEFAULT_PAGE_PADDING,
      height: 300 + 2 * DEFAULT_PAGE_PADDING,
    });
    // …and the region is the page frame alone, which is what carries the
    // backdrop fills into that new area.
    expect(state().rootIds).toEqual([pageId]);
    expect(state().nodes[pageId]!.fills).toHaveLength(1);
  });

  it("composes with crop: padding after a crop pads the cropped page", () => {
    const { pageId } = seed();
    state().select([pageId]);
    state().beginCrop();
    state().setCropRect({ x: 100, y: 50, width: 200, height: 150 });
    state().commitCrop();
    // The capture is unchanged by the crop, so padding still measures against
    // it — the page grows back out around the full bitmap plus the margin.
    state().setPagePadding(20);
    const p = page(pageId);
    expect({ x: p.x, y: p.y, width: p.width, height: p.height }).toEqual({
      x: -20,
      y: -20,
      width: 440,
      height: 340,
    });
  });
});
