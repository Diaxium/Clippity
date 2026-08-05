import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LibraryFacets } from "@services/tauri/clients/library";

const libraryFacetsMock = vi.fn();
const emitErrorToastMock = vi.fn();
let updatedHandler: (() => void) | null = null;
const updatedUnsub = vi.fn();

vi.mock("@services/tauri/clients/library", () => ({
  libraryFacets: (...args: unknown[]) => libraryFacetsMock(...args),
  onLibraryUpdated: (cb: () => void) => {
    updatedHandler = cb;
    return updatedUnsub;
  },
}));

vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...args: unknown[]) => emitErrorToastMock(...args),
}));

import { useLibraryFacets } from "./useLibraryFacets";

const facets = (total: number): LibraryFacets => ({
  total,
  kinds: { image: total },
  favorites: 1,
  trashed: 2,
  tags: [{ tag: "bug", count: 1 }],
  smart: { thisWeek: total, last30Days: total, large: 0, untagged: 0 },
});

describe("useLibraryFacets", () => {
  beforeEach(() => {
    libraryFacetsMock.mockReset();
    emitErrorToastMock.mockReset();
    updatedUnsub.mockReset();
    updatedHandler = null;
  });

  afterEach(() => vi.clearAllMocks());

  it("starts at zero so the rail renders before the counts land", () => {
    libraryFacetsMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useLibraryFacets());
    expect(result.current.facets.total).toBe(0);
    expect(result.current.facets.tags).toEqual([]);
    expect(result.current.facets.smart.thisWeek).toBe(0);
  });

  it("fetches with the smart thresholds on mount", async () => {
    libraryFacetsMock.mockResolvedValue(facets(9));
    const { result } = renderHook(() => useLibraryFacets());
    await waitFor(() => expect(result.current.facets.total).toBe(9));

    const query = libraryFacetsMock.mock.calls[0]?.[0] as Record<
      string,
      number
    >;
    expect(query).toHaveProperty("thisWeekSinceMs");
    expect(query).toHaveProperty("last30DaysSinceMs");
    expect(query.largeMinBytes).toBeGreaterThan(0);
  });

  it("re-counts on library/updated", async () => {
    libraryFacetsMock
      .mockResolvedValueOnce(facets(9))
      .mockResolvedValueOnce(facets(10));
    const { result } = renderHook(() => useLibraryFacets());
    await waitFor(() => expect(result.current.facets.total).toBe(9));

    // A capture landing, a star or a trash op moves these numbers.
    await act(async () => {
      updatedHandler?.();
    });
    await waitFor(() => expect(result.current.facets.total).toBe(10));
  });

  it("re-reads the clock on each refresh so a window can't age", async () => {
    libraryFacetsMock.mockResolvedValue(facets(1));
    const { result } = renderHook(() => useLibraryFacets());
    await waitFor(() => expect(result.current.facets.total).toBe(1));

    const first = libraryFacetsMock.mock.calls[0]?.[0] as {
      last30DaysSinceMs: number;
    };
    vi.setSystemTime(new Date(Date.now() + 86_400_000));
    await act(async () => {
      updatedHandler?.();
    });
    await waitFor(() => expect(libraryFacetsMock).toHaveBeenCalledTimes(2));

    const second = libraryFacetsMock.mock.calls[1]?.[0] as {
      last30DaysSinceMs: number;
    };
    expect(second.last30DaysSinceMs).toBeGreaterThan(first.last30DaysSinceMs);
    vi.useRealTimers();
  });

  it("keeps the previous counts when a refresh fails", async () => {
    libraryFacetsMock
      .mockResolvedValueOnce(facets(9))
      .mockRejectedValueOnce(new Error("index locked"));
    const { result } = renderHook(() => useLibraryFacets());
    await waitFor(() => expect(result.current.facets.total).toBe(9));

    await act(async () => {
      updatedHandler?.();
    });
    await waitFor(() =>
      expect(emitErrorToastMock).toHaveBeenCalledWith("index locked")
    );
    // A rail showing slightly stale numbers beats one blanking to zero
    // beside a full grid.
    expect(result.current.facets.total).toBe(9);
  });

  it("tolerates a malformed answer rather than taking the page down", async () => {
    libraryFacetsMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useLibraryFacets());
    await waitFor(() => expect(libraryFacetsMock).toHaveBeenCalled());
    expect(result.current.facets.total).toBe(0);
    expect(result.current.facets.kinds).toEqual({});
  });

  it("unsubscribes from library/updated on unmount", () => {
    libraryFacetsMock.mockResolvedValue(facets(0));
    const { unmount } = renderHook(() => useLibraryFacets());
    unmount();
    expect(updatedUnsub).toHaveBeenCalledTimes(1);
  });
});
