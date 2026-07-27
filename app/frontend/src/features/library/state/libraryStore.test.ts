import { beforeEach, describe, expect, it } from "vitest";

import { useLibraryStore } from "./libraryStore";

const initial = useLibraryStore.getState();

describe("libraryStore", () => {
  beforeEach(() => {
    useLibraryStore.setState(initial, true);
  });

  it("defaults to library mode, all kinds, grid view, nothing narrowed", () => {
    const s = useLibraryStore.getState();
    expect(s.mode).toBe("library");
    expect(s.kindFilter).toBe("all");
    expect(s.view).toBe("grid");
    expect(s.favoritesOnly).toBe(false);
    expect(s.tagFilter).toBeNull();
    expect(s.collectionId).toBeNull();
    expect(s.selected).toEqual([]);
  });

  it("setMode switches between library and trash", () => {
    useLibraryStore.getState().setMode("trash");
    expect(useLibraryStore.getState().mode).toBe("trash");
    useLibraryStore.getState().setMode("library");
    expect(useLibraryStore.getState().mode).toBe("library");
  });

  it("setKindFilter updates the kind tab", () => {
    useLibraryStore.getState().setKindFilter("image");
    expect(useLibraryStore.getState().kindFilter).toBe("image");
  });

  it("setView toggles grid/list", () => {
    useLibraryStore.getState().setView("list");
    expect(useLibraryStore.getState().view).toBe("list");
  });

  it("switching mode clears every refinement and the selection", () => {
    // Mode is a context switch, not a refinement: a filter left over
    // from the other context silently hides rows, and a selection names
    // captures that are no longer on screen.
    const s = useLibraryStore.getState();
    s.setKindFilter("video");
    s.toggleFavoritesOnly();
    s.setTagFilter("bug");
    s.setCollectionId("col_1");
    s.toggleSelected("/tmp/a.png");

    useLibraryStore.getState().setMode("trash");
    const after = useLibraryStore.getState();
    expect(after.kindFilter).toBe("all");
    expect(after.favoritesOnly).toBe(false);
    expect(after.tagFilter).toBeNull();
    expect(after.collectionId).toBeNull();
    expect(after.selected).toEqual([]);
  });

  it("toggleFavoritesOnly flips both ways", () => {
    useLibraryStore.getState().toggleFavoritesOnly();
    expect(useLibraryStore.getState().favoritesOnly).toBe(true);
    useLibraryStore.getState().toggleFavoritesOnly();
    expect(useLibraryStore.getState().favoritesOnly).toBe(false);
  });

  it("opening a collection drops a selection made against the old list", () => {
    useLibraryStore.getState().toggleSelected("/tmp/a.png");
    useLibraryStore.getState().setCollectionId("col_1");
    const s = useLibraryStore.getState();
    expect(s.collectionId).toBe("col_1");
    expect(s.selected).toEqual([]);
  });

  it("selection keeps click order and toggles individual ids", () => {
    // Order matters: "add to collection" appends the captures the way
    // the user picked them.
    const s = useLibraryStore.getState();
    s.toggleSelected("/b.png");
    s.toggleSelected("/a.png");
    expect(useLibraryStore.getState().selected).toEqual(["/b.png", "/a.png"]);

    useLibraryStore.getState().toggleSelected("/b.png");
    expect(useLibraryStore.getState().selected).toEqual(["/a.png"]);
  });

  it("clearSelection empties it without touching the filters", () => {
    const s = useLibraryStore.getState();
    s.setTagFilter("bug");
    s.toggleSelected("/a.png");
    useLibraryStore.getState().clearSelection();
    const after = useLibraryStore.getState();
    expect(after.selected).toEqual([]);
    expect(after.tagFilter).toBe("bug");
  });

  describe("range selection", () => {
    const ORDER = ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"];

    beforeEach(() => {
      useLibraryStore.getState().setVisibleIds(ORDER);
    });

    it("selects the run between the anchor and the target", () => {
      useLibraryStore.getState().toggleSelected("/b.png"); // anchor
      useLibraryStore.getState().selectRange("/d.png", false);
      expect(useLibraryStore.getState().selected).toEqual([
        "/b.png",
        "/c.png",
        "/d.png",
      ]);
    });

    it("ranges upward from the anchor, still in screen order", () => {
      // The selection list is ordered because "add to collection"
      // appends in it — a user who Shift-clicked upward pointed at a
      // block, not at a reversed one.
      useLibraryStore.getState().toggleSelected("/d.png");
      useLibraryStore.getState().selectRange("/b.png", false);
      expect(useLibraryStore.getState().selected).toEqual([
        "/b.png",
        "/c.png",
        "/d.png",
      ]);
    });

    it("falls back to the focused capture when nothing is selected yet", () => {
      // A plain click only focuses, so this is the cold-start case the
      // whole gesture exists for.
      useLibraryStore.getState().setFocused("/b.png");
      useLibraryStore.getState().selectRange("/c.png", false);
      expect(useLibraryStore.getState().selected).toEqual(["/b.png", "/c.png"]);
    });

    it("keeps the pivot so successive shift-clicks re-range, not walk", () => {
      useLibraryStore.getState().toggleSelected("/b.png");
      useLibraryStore.getState().selectRange("/e.png", false);
      useLibraryStore.getState().selectRange("/c.png", false);
      expect(useLibraryStore.getState().selected).toEqual(["/b.png", "/c.png"]);
      expect(useLibraryStore.getState().anchorId).toBe("/b.png");
    });

    it("replaces the selection unless the range is additive", () => {
      useLibraryStore.getState().toggleSelected("/e.png");
      useLibraryStore.getState().setFocused("/a.png");
      useLibraryStore.getState().selectRange("/b.png", false);
      expect(useLibraryStore.getState().selected).toEqual(["/a.png", "/b.png"]);

      useLibraryStore.getState().clearSelection();
      useLibraryStore.getState().toggleSelected("/e.png");
      useLibraryStore.getState().setFocused("/a.png");
      useLibraryStore.getState().selectRange("/b.png", true);
      expect(useLibraryStore.getState().selected).toEqual([
        "/e.png",
        "/a.png",
        "/b.png",
      ]);
    });

    it("an additive range never duplicates what is already selected", () => {
      useLibraryStore.getState().toggleSelected("/c.png");
      useLibraryStore.getState().setFocused("/b.png");
      useLibraryStore.getState().selectRange("/d.png", true);
      expect(useLibraryStore.getState().selected).toEqual([
        "/c.png",
        "/b.png",
        "/d.png",
      ]);
    });

    it("selects only the target when the pivot is no longer on screen", () => {
      useLibraryStore.getState().toggleSelected("/gone.png");
      useLibraryStore.getState().selectRange("/c.png", false);
      expect(useLibraryStore.getState().selected).toEqual(["/c.png"]);
      expect(useLibraryStore.getState().anchorId).toBe("/c.png");
    });

    it("ignores a target that isn't on screen", () => {
      useLibraryStore.getState().toggleSelected("/b.png");
      useLibraryStore.getState().selectRange("/gone.png", false);
      expect(useLibraryStore.getState().selected).toEqual(["/b.png"]);
    });

    it("focusing moves the pivot, closing the inspector does not", () => {
      useLibraryStore.getState().toggleSelected("/b.png");
      useLibraryStore.getState().setFocused("/d.png");
      expect(useLibraryStore.getState().anchorId).toBe("/d.png");
      useLibraryStore.getState().setFocused(null);
      expect(useLibraryStore.getState().anchorId).toBe("/d.png");
    });

    it("selectAll takes everything on screen, and clearing drops the anchor", () => {
      useLibraryStore.getState().selectAll();
      expect(useLibraryStore.getState().selected).toEqual(ORDER);
      useLibraryStore.getState().clearSelection();
      expect(useLibraryStore.getState().anchorId).toBeNull();
    });
  });
});
