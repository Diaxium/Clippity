import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureMeta } from "@services/tauri/clients/library";

const isTauriContextMock = vi.fn();
const libraryListMock = vi.fn();
const libraryThumbnailMock = vi.fn();
let libraryUpdatedHandler: (() => void) | null = null;
let trayOpenedHandler: (() => void) | null = null;

vi.mock("@services/tauri", () => ({
  isTauriContext: () => isTauriContextMock(),
}));

vi.mock("@services/tauri/clients/library", () => ({
  libraryList: (includeTrashed: boolean) => libraryListMock(includeTrashed),
  libraryThumbnail: (id: string, w: number) => libraryThumbnailMock(id, w),
  onLibraryUpdated: (h: () => void) => {
    libraryUpdatedHandler = h;
    return () => {
      if (libraryUpdatedHandler === h) libraryUpdatedHandler = null;
    };
  },
}));

vi.mock("@services/tauri/clients/tray", () => ({
  onTrayOpened: (h: () => void) => {
    trayOpenedHandler = h;
    return () => {
      if (trayOpenedHandler === h) trayOpenedHandler = null;
    };
  },
}));

import { pickRecents, useRecentCaptures } from "./useRecentCaptures";

function meta(id: string, kind: CaptureMeta["kind"] = "image"): CaptureMeta {
  return { id, title: id, kind, createdAtMs: 0, sizeBytes: 1, trashed: false };
}

describe("pickRecents", () => {
  it("floats favorites to the front, keeping listing order within each", () => {
    // The strip is the tray's whole view of the library; a starred
    // capture is the user saying "this is the one I keep coming back
    // to", which outranks recency in a quick-access surface.
    const all = [
      meta("newest"),
      { ...meta("starred-older"), favorite: true },
      meta("older"),
      { ...meta("starred-oldest"), favorite: true },
    ];
    expect(pickRecents(all).map((c) => c.id)).toEqual([
      "starred-older",
      "starred-oldest",
      "newest",
      "older",
    ]);
  });

  it("still reads as newest-first when nothing is starred", () => {
    const all = [meta("a"), meta("b"), meta("c")];
    expect(pickRecents(all).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps only images, capped at the strip's width", () => {
    const all = [
      meta("vid", "video"),
      meta("1"),
      meta("2"),
      meta("3"),
      meta("4"),
      meta("5"),
    ];
    expect(pickRecents(all).map((c) => c.id)).toEqual(["1", "2", "3", "4"]);
  });
});

describe("useRecentCaptures", () => {
  beforeEach(() => {
    isTauriContextMock.mockReset().mockReturnValue(true);
    libraryListMock.mockReset().mockResolvedValue([]);
    libraryThumbnailMock
      .mockReset()
      .mockResolvedValue("data:image/png;base64,AAA");
    libraryUpdatedHandler = null;
    trayOpenedHandler = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the newest image captures with thumbnails on mount", async () => {
    libraryListMock.mockResolvedValue([meta("a"), meta("b")]);
    const { result } = renderHook(() => useRecentCaptures());
    await waitFor(() => expect(result.current.recents).toHaveLength(2));
    expect(result.current.recents[0]).toMatchObject({
      id: "a",
      thumb: "data:image/png;base64,AAA",
    });
  });

  it("caps at four and filters out non-image kinds", async () => {
    libraryListMock.mockResolvedValue([
      meta("img1"),
      meta("vid", "video"),
      meta("img2"),
      meta("img3"),
      meta("img4"),
      meta("img5"),
    ]);
    const { result } = renderHook(() => useRecentCaptures());
    await waitFor(() =>
      expect(result.current.recents.length).toBeGreaterThan(0)
    );
    expect(result.current.recents).toHaveLength(4);
    expect(result.current.recents.map((r) => r.id)).not.toContain("vid");
  });

  it("refetches when the tray panel opens", async () => {
    libraryListMock.mockResolvedValue([meta("first")]);
    const { result } = renderHook(() => useRecentCaptures());
    await waitFor(() => expect(result.current.recents).toHaveLength(1));

    libraryListMock.mockResolvedValue([meta("x"), meta("y")]);
    await act(async () => {
      trayOpenedHandler?.();
    });
    await waitFor(() => expect(result.current.recents).toHaveLength(2));
  });

  it("stays empty outside a Tauri context", async () => {
    isTauriContextMock.mockReturnValue(false);
    libraryListMock.mockResolvedValue([meta("a")]);
    const { result } = renderHook(() => useRecentCaptures());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.recents).toHaveLength(0);
    expect(libraryListMock).not.toHaveBeenCalled();
  });
});
