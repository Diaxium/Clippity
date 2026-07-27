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
  makeEllipse,
  makeFrame,
  makeImage,
  makeRectangle,
  makeSolidPaint,
  type ImageNode,
} from "../../types";
import {
  DEFAULT_CHROME_HEIGHT,
  DEFAULT_CHROME_RADIUS,
  chromeWindowRect,
  matchChromePreset,
} from "../../lib/chrome";
import { pageContent, pagePadding } from "../../lib/page";
import { unionBounds } from "../../geometry";
import { useEditorStore } from "../../state/editorStore";
import { ChromeSection } from "./ChromeSection";

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
const node = (id: string) => state().nodes[id]!;
/** The capture is seeded as an image node, so it always has a radius. */
const radius = (id: string) => (node(id) as ImageNode).cornerRadius;

afterEach(cleanup);
beforeEach(() => useEditorStore.setState({ sectionsOpen: {} }));

describe("ChromeSection scoping", () => {
  it("shows on an empty selection — that is how you address the page", () => {
    seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    expect(screen.getByRole("heading", { name: "Window" })).toBeInTheDocument();
  });

  it("shows when the page frame itself is selected", () => {
    const { pageId } = seed();
    act(() => state().select([pageId]));
    render(<ChromeSection />);
    expect(screen.getByRole("heading", { name: "Window" })).toBeInTheDocument();
  });

  it("hides while a mark is selected — that is not the page", () => {
    const { markId } = seed();
    act(() => state().select([markId]));
    render(<ChromeSection />);
    expect(screen.queryByRole("heading", { name: "Window" })).toBeNull();
  });

  it("hides when the capture can't carry a title bar", () => {
    // An ellipse can hold the largest image fill, but neither renderer draws
    // chrome on one — so the control must not promise what won't arrive.
    __resetNodeIdForTests();
    const frame = makeFrame(PAGE, { name: "Page" });
    const blob = makeEllipse(PAGE, { name: "Blob" });
    blob.fills = [{ ...makeSolidPaint("#000"), type: "image", src: "data:," }];
    frame.children = [blob.id];
    act(() =>
      useEditorStore.getState().loadScene({
        rootIds: [frame.id],
        nodes: { [frame.id]: frame, [blob.id]: blob },
        docName: "Page",
        sourceId: null,
      })
    );
    act(() => state().clearSelection());
    render(<ChromeSection />);
    expect(screen.queryByRole("heading", { name: "Window" })).toBeNull();
  });
});

describe("applying chrome", () => {
  it("frames the capture and opens room for the bar in one step", () => {
    const { pageId, photoId } = seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));

    const photo = node(photoId);
    expect(photo.chrome?.style).toBe("macos");
    // The page grew upward by exactly the bar, so it doesn't clip it.
    expect(node(pageId).y).toBe(PAGE.y - DEFAULT_CHROME_HEIGHT);
    expect(node(pageId).height).toBe(PAGE.height + DEFAULT_CHROME_HEIGHT);
  });

  it("rounds a square-cornered capture, so the window doesn't look broken", () => {
    const { photoId } = seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    expect(radius(photoId)).toBe(DEFAULT_CHROME_RADIUS);
  });

  it("leaves an existing radius alone", () => {
    const { photoId } = seed();
    act(() => state().setContentRadius(4));
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    expect(radius(photoId)).toBe(4);
  });

  it("applies chrome as one undo step, page resize included", () => {
    const { pageId, photoId } = seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    act(() => state().undo());
    expect(node(photoId).chrome ?? null).toBeNull();
    expect(node(pageId).y).toBe(PAGE.y);
    expect(node(pageId).height).toBe(PAGE.height);
  });

  it("swaps styles without losing the typed title", () => {
    const { photoId } = seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    fireEvent.change(screen.getByLabelText("Window title"), {
      target: { value: "Dashboard" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Windows dark" }));
    expect(node(photoId).chrome?.style).toBe("windows");
    expect(node(photoId).chrome?.title).toBe("Dashboard");
  });

  it("removes the chrome and the room it took", () => {
    const { pageId, photoId } = seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(node(photoId).chrome ?? null).toBeNull();
    expect(node(pageId).y).toBe(PAGE.y);
    expect(node(pageId).height).toBe(PAGE.height);
  });

  it("keeps the backdrop margin intact around the taller window", () => {
    const { pageId } = seed();
    act(() => state().applyBackdrop("violet"));
    const before = pagePadding(node(pageId), pageContent(state().nodes)!.rect);
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    const after = pagePadding(node(pageId), pageContent(state().nodes)!.rect);
    expect(after).toBe(before);
  });
});

describe("chrome fields", () => {
  it("only offers title and height once a bar exists", () => {
    seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    expect(screen.queryByLabelText("Window title")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    expect(screen.getByLabelText("Window title")).toBeInTheDocument();
  });

  it("keeps the preset highlighted when only the height changes", () => {
    const { photoId } = seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    act(() => state().setChromeHeight(64));
    expect(node(photoId).chrome?.height).toBe(64);
    // A taller macOS bar is still macOS — height isn't part of the identity.
    expect(matchChromePreset(node(photoId).chrome)).toBe("macos");
    expect(screen.getByRole("button", { name: "macOS" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("re-grows the page when the bar gets taller", () => {
    const { pageId } = seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));
    act(() => state().setChromeHeight(80));
    expect(node(pageId).height).toBe(PAGE.height + 80);
  });
});

describe("the export region still matches the canvas", () => {
  it("seals a stray annotation root into the grown page", () => {
    // ADR 0019/0020's trap, reached a third way: chrome grows the page, and a
    // stray root outside it would stretch `unionBounds` past the backdrop —
    // exporting an unpainted band that is invisible on the live canvas.
    const { pageId } = seed();
    __resetNodeIdForTests();
    const stray = makeRectangle({ x: 900, y: 40, width: 60, height: 60 });
    act(() =>
      useEditorStore.setState((s) => ({
        rootIds: [...s.rootIds, stray.id],
        nodes: { ...s.nodes, [stray.id]: stray },
      }))
    );
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));

    expect(state().rootIds).toEqual([pageId]);
    const region = unionBounds([node(pageId)])!;
    const page = node(pageId);
    expect(region).toEqual({
      x: page.x,
      y: page.y,
      width: page.width,
      height: page.height,
    });
  });

  it("the export region covers the title bar", () => {
    const { pageId, photoId } = seed();
    act(() => state().clearSelection());
    render(<ChromeSection />);
    fireEvent.click(screen.getByRole("button", { name: "macOS" }));

    const win = chromeWindowRect(node(photoId));
    const region = unionBounds([node(pageId)])!;
    expect(region.y).toBeLessThanOrEqual(win.y);
    expect(region.y + region.height).toBeGreaterThanOrEqual(win.y + win.height);
  });
});
