import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureMeta } from "@services/tauri/clients/library";

const libraryListMock = vi.fn();
const emitErrorToastMock = vi.fn();
let updatedHandler: (() => void) | null = null;
const updatedUnsub = vi.fn();

vi.mock("@services/tauri/clients/library", () => ({
  libraryList: (...args: unknown[]) => libraryListMock(...args),
  onLibraryUpdated: (cb: () => void) => {
    updatedHandler = cb;
    return updatedUnsub;
  },
}));

vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...args: unknown[]) => emitErrorToastMock(...args),
}));

import { useLibraryList } from "./useLibraryList";

const sample: CaptureMeta = {
  id: "/tmp/captures/a.png",
  title: "a",
  kind: "image",
  createdAtMs: 1,
  sizeBytes: 10,
  trashed: false,
};

describe("useLibraryList", () => {
  beforeEach(() => {
    libraryListMock.mockReset();
    emitErrorToastMock.mockReset();
    updatedUnsub.mockReset();
    updatedHandler = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fetches on mount and exposes items", async () => {
    libraryListMock.mockResolvedValue([sample]);
    const { result } = renderHook(() => useLibraryList(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(libraryListMock).toHaveBeenCalledWith(false);
    expect(result.current.items).toEqual([sample]);
  });

  it("passes includeTrashed through to the IPC call", async () => {
    libraryListMock.mockResolvedValue([]);
    renderHook(() => useLibraryList(true));
    await waitFor(() => expect(libraryListMock).toHaveBeenCalledWith(true));
  });

  it("refetches when library/updated fires", async () => {
    libraryListMock.mockResolvedValue([sample]);
    const { result } = renderHook(() => useLibraryList(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(libraryListMock).toHaveBeenCalledTimes(1);

    libraryListMock.mockResolvedValueOnce([
      sample,
      { ...sample, id: "/tmp/captures/b.png" },
    ]);
    await act(async () => {
      updatedHandler?.();
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(libraryListMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces an error toast + empties the list on fetch failure", async () => {
    libraryListMock.mockRejectedValueOnce(new Error("scan failed"));
    const { result } = renderHook(() => useLibraryList(false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(emitErrorToastMock).toHaveBeenCalledWith("scan failed");
    expect(result.current.items).toEqual([]);
  });

  it("unsubscribes from the event listener on unmount", () => {
    libraryListMock.mockResolvedValue([]);
    const { unmount } = renderHook(() => useLibraryList(false));
    unmount();
    expect(updatedUnsub).toHaveBeenCalledTimes(1);
  });
});
