import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CapturePage,
  LibraryQuery,
} from "@services/tauri/clients/library";

const libraryQueryMock = vi.fn();
const emitErrorToastMock = vi.fn();
let updatedHandler: (() => void) | null = null;
const updatedUnsub = vi.fn();

vi.mock("@services/tauri/clients/library", () => ({
  libraryQuery: (...args: unknown[]) => libraryQueryMock(...args),
  onLibraryUpdated: (cb: () => void) => {
    updatedHandler = cb;
    return updatedUnsub;
  },
}));

vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...args: unknown[]) => emitErrorToastMock(...args),
}));

import { useLibraryQuery } from "./useLibraryQuery";

/** A page of `n` rows starting at `from`, out of `total`. */
function page(from: number, n: number, total: number): CapturePage {
  return {
    total,
    items: Array.from({ length: n }, (_, i) => ({
      id: `/caps/${from + i}.png`,
      title: `cap-${from + i}`,
      kind: "image" as const,
      createdAtMs: from + i,
      sizeBytes: 10,
      trashed: false,
    })),
  };
}

describe("useLibraryQuery", () => {
  beforeEach(() => {
    libraryQueryMock.mockReset();
    emitErrorToastMock.mockReset();
    updatedUnsub.mockReset();
    updatedHandler = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the first page on mount with managed limit/offset", async () => {
    libraryQueryMock.mockResolvedValue(page(0, 100, 250));
    const { result } = renderHook(() =>
      useLibraryQuery({ search: "bug", sort: "newest" })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(libraryQueryMock).toHaveBeenCalledWith({
      search: "bug",
      sort: "newest",
      limit: 100,
      offset: 0,
    });
    expect(result.current.items).toHaveLength(100);
    expect(result.current.total).toBe(250);
    expect(result.current.hasMore).toBe(true);
  });

  it("appends the next page on loadMore and stops at total", async () => {
    libraryQueryMock
      .mockResolvedValueOnce(page(0, 100, 150))
      .mockResolvedValueOnce(page(100, 50, 150));
    const { result } = renderHook(() => useLibraryQuery({}));
    await waitFor(() => expect(result.current.items).toHaveLength(100));

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(150));

    expect(libraryQueryMock).toHaveBeenLastCalledWith({
      limit: 100,
      offset: 100,
    });
    expect(result.current.hasMore).toBe(false);

    // Nothing left to load — loadMore is a no-op.
    act(() => result.current.loadMore());
    expect(libraryQueryMock).toHaveBeenCalledTimes(2);
  });

  it("restarts pagination when the filter set changes", async () => {
    libraryQueryMock.mockResolvedValue(page(0, 10, 10));
    const { result, rerender } = renderHook(
      ({ q }: { q: LibraryQuery }) => useLibraryQuery(q),
      { initialProps: { q: { search: "a" } as LibraryQuery } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(libraryQueryMock).toHaveBeenCalledTimes(1);

    rerender({ q: { search: "b" } });
    await waitFor(() =>
      expect(libraryQueryMock).toHaveBeenLastCalledWith({
        search: "b",
        limit: 100,
        offset: 0,
      })
    );
  });

  it("does not refetch when a fresh-but-equal query object is passed", async () => {
    libraryQueryMock.mockResolvedValue(page(0, 5, 5));
    const { result, rerender } = renderHook(
      ({ q }: { q: LibraryQuery }) => useLibraryQuery(q),
      { initialProps: { q: { search: "same" } as LibraryQuery } }
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A new object with identical values must not restart the list.
    rerender({ q: { search: "same" } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(libraryQueryMock).toHaveBeenCalledTimes(1);
  });

  it("reloads from the top on library/updated", async () => {
    libraryQueryMock.mockResolvedValue(page(0, 3, 3));
    const { result } = renderHook(() => useLibraryQuery({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(libraryQueryMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      updatedHandler?.();
    });
    await waitFor(() => expect(libraryQueryMock).toHaveBeenCalledTimes(2));
    expect(libraryQueryMock).toHaveBeenLastCalledWith({
      limit: 100,
      offset: 0,
    });
  });

  it("toasts and empties on a first-page failure", async () => {
    libraryQueryMock.mockRejectedValueOnce(new Error("index locked"));
    const { result } = renderHook(() => useLibraryQuery({}));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(emitErrorToastMock).toHaveBeenCalledWith("index locked");
    expect(result.current.items).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it("unsubscribes from library/updated on unmount", () => {
    libraryQueryMock.mockResolvedValue(page(0, 0, 0));
    const { unmount } = renderHook(() => useLibraryQuery({}));
    unmount();
    expect(updatedUnsub).toHaveBeenCalledTimes(1);
  });
});
