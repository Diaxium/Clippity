import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDesktopSnapshotIdMock = vi.fn();
const listeners: Record<string, (payload: never) => void> = {};

vi.mock("@services/tauri/clients/overlay", () => ({
  getDesktopSnapshotId: () => getDesktopSnapshotIdMock(),
  // The real one goes through Tauri's `convertFileSrc`; the shape is what
  // matters here — an id in the path, so each session gets its own URL.
  desktopSnapshotUrl: (id: number) =>
    `http://clippity-snapshot.localhost/${id}`,
  onOverlayOpening: (cb: (p: never) => void) => {
    listeners.opening = cb;
    return () => delete listeners.opening;
  },
  onOverlayShown: (cb: (p: never) => void) => {
    listeners.shown = cb;
    return () => delete listeners.shown;
  },
  onOverlaySnapshotReady: (cb: (p: never) => void) => {
    listeners.ready = cb;
    return () => delete listeners.ready;
  },
}));

import { useOverlaySnapshot } from "./useOverlaySnapshot";
import { useOverlayStore } from "../state/overlayStore";

const fetchMock = vi.fn();
const createImageBitmapMock = vi.fn();

/**
 * A 2D context stub — the hook only draws into it and hands it on.
 *
 * Intercepts `createElement("canvas")` only and delegates every other
 * tag to the real DOM: Testing Library builds its own container through
 * the same call, so a blanket mock takes the renderer down with it.
 */
function stubCanvas() {
  const ctx = {
    drawImage: vi.fn(),
    canvas: { width: 0, height: 0 },
  } as unknown as CanvasRenderingContext2D;
  const real = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions
  ) => {
    if (tag !== "canvas") return real(tag, options);
    return { getContext: () => ctx } as unknown as HTMLElement;
  }) as typeof document.createElement);
  return ctx;
}

beforeEach(() => {
  getDesktopSnapshotIdMock.mockReset();
  fetchMock.mockReset();
  createImageBitmapMock.mockReset();

  fetchMock.mockResolvedValue({ ok: true, blob: () => Promise.resolve({}) });
  createImageBitmapMock.mockResolvedValue({
    width: 1920,
    height: 1200,
    close: vi.fn(),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("createImageBitmap", createImageBitmapMock);
  useOverlayStore.getState().reset(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useOverlaySnapshot", () => {
  it("loads the snapshot over its URL, not through the IPC result", async () => {
    stubCanvas();
    getDesktopSnapshotIdMock.mockResolvedValue(7);

    renderHook(() => useOverlaySnapshot());

    await waitFor(() =>
      expect(useOverlayStore.getState().snapshot.url).toBe(
        "http://clippity-snapshot.localhost/7"
      )
    );
    // The command answers with an id — the pixels come over the scheme.
    // This is the whole point of the transport: an 8 MiB desktop must
    // never be serialized into a command result.
    expect(fetchMock).toHaveBeenCalledWith(
      "http://clippity-snapshot.localhost/7"
    );
    expect(useOverlayStore.getState().snapshot.sampleCtx).not.toBeNull();
  });

  it("does not re-decode when both show events resolve the same snapshot", async () => {
    stubCanvas();
    getDesktopSnapshotIdMock.mockResolvedValue(7);
    renderHook(() => useOverlaySnapshot());
    await waitFor(() => expect(createImageBitmapMock).toHaveBeenCalledTimes(1));

    // SHOWN and SNAPSHOT_READY can both land on a fast monitor.
    await act(async () => {
      listeners.shown?.({ snapshotOk: true, mode: "region" } as never);
      listeners.ready?.(undefined as never);
    });
    await waitFor(() => expect(getDesktopSnapshotIdMock).toHaveBeenCalled());
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
  });

  it("decodes again when a new session mints a new id", async () => {
    stubCanvas();
    getDesktopSnapshotIdMock.mockResolvedValue(7);
    renderHook(() => useOverlaySnapshot());
    await waitFor(() => expect(createImageBitmapMock).toHaveBeenCalledTimes(1));

    // A fresh overlay session — different desktop, different URL, so the
    // webview cache can't serve the previous session's pixels.
    getDesktopSnapshotIdMock.mockResolvedValue(8);
    await act(async () => {
      listeners.ready?.(undefined as never);
    });
    await waitFor(() => expect(createImageBitmapMock).toHaveBeenCalledTimes(2));
    expect(useOverlayStore.getState().snapshot.url).toBe(
      "http://clippity-snapshot.localhost/8"
    );
  });

  it("stays quiet while no snapshot is servable yet", async () => {
    getDesktopSnapshotIdMock.mockResolvedValue(null);
    renderHook(() => useOverlaySnapshot());
    await waitFor(() => expect(getDesktopSnapshotIdMock).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useOverlayStore.getState().snapshot.url).toBeNull();
  });

  it("leaves the loupe unset when the fetch fails", async () => {
    getDesktopSnapshotIdMock.mockResolvedValue(7);
    fetchMock.mockResolvedValue({ ok: false });
    renderHook(() => useOverlaySnapshot());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(useOverlayStore.getState().snapshot.sampleCtx).toBeNull();
  });
});
