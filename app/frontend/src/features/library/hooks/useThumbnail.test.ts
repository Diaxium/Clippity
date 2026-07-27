import { useRef } from "react";

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const libraryThumbnailMock = vi.fn();

vi.mock("@services/tauri/clients/library", () => ({
  libraryThumbnail: (...args: unknown[]) => libraryThumbnailMock(...args),
}));

import {
  __resetThumbnailCacheForTests,
  __thumbnailCacheSizeForTests,
  useThumbnail,
} from "./useThumbnail";

// Per-test IntersectionObserver mock that captures the callback so
// the test can simulate the element scrolling into view. Local type
// alias for the DOM-global callback signature — matches the
// `ObserverCallback` shape `useToastResize.test.ts` uses for
// `ResizeObserverCallback` to satisfy ESLint's `no-undef` rule.
type IOCallback = (
  entries: IntersectionObserverEntry[],
  observer: IntersectionObserver
) => void;

let ioCallback: IOCallback | null = null;
const observeMock = vi.fn();
const ioDisconnectMock = vi.fn();

class RecordingIO implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
  constructor(cb: IOCallback) {
    ioCallback = cb;
  }
  observe = (el: Element) => observeMock(el);
  unobserve = () => {};
  disconnect = () => ioDisconnectMock();
  takeRecords = () => [];
}

beforeEach(() => {
  libraryThumbnailMock.mockReset();
  observeMock.mockReset();
  ioDisconnectMock.mockReset();
  ioCallback = null;
  __resetThumbnailCacheForTests();
  globalThis.IntersectionObserver =
    RecordingIO as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Simulate the observed element becoming visible. */
function scrollIntoView() {
  ioCallback?.(
    [{ isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver
  );
}

describe("useThumbnail", () => {
  it("fetches immediately when ref is null (eager mode)", async () => {
    libraryThumbnailMock.mockResolvedValueOnce("data:image/png;base64,eager");
    const { result } = renderHook(() =>
      useThumbnail(null, "/tmp/captures/a.png", 480)
    );
    await waitFor(() =>
      expect(result.current).toBe("data:image/png;base64,eager")
    );
    expect(libraryThumbnailMock).toHaveBeenCalledWith(
      "/tmp/captures/a.png",
      480
    );
  });

  it("defers the fetch until the element scrolls into view", async () => {
    libraryThumbnailMock.mockResolvedValueOnce("data:image/png;base64,lazy");
    const el = document.createElement("div");

    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(el);
      return useThumbnail(ref, "/tmp/captures/lazy.png", 480);
    });

    // Not fetched yet — element hasn't intersected.
    expect(libraryThumbnailMock).not.toHaveBeenCalled();
    expect(observeMock).toHaveBeenCalledWith(el);

    await act(async () => {
      scrollIntoView();
    });
    await waitFor(() =>
      expect(result.current).toBe("data:image/png;base64,lazy")
    );
  });

  it("serves a cached value synchronously on a second mount", async () => {
    libraryThumbnailMock.mockResolvedValueOnce("data:image/png;base64,cached");
    const first = renderHook(() =>
      useThumbnail(null, "/tmp/captures/c.png", 480)
    );
    await waitFor(() =>
      expect(first.result.current).toBe("data:image/png;base64,cached")
    );
    expect(libraryThumbnailMock).toHaveBeenCalledTimes(1);

    // Second mount of the same (id, width) hits the cache — no new IPC.
    const second = renderHook(() =>
      useThumbnail(null, "/tmp/captures/c.png", 480)
    );
    expect(second.result.current).toBe("data:image/png;base64,cached");
    expect(libraryThumbnailMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent fetches for the same (id, width)", async () => {
    libraryThumbnailMock.mockResolvedValue("data:image/png;base64,shared");
    // Two eager mounts of the same key, before the promise resolves.
    renderHook(() => useThumbnail(null, "/tmp/captures/d.png", 480));
    renderHook(() => useThumbnail(null, "/tmp/captures/d.png", 480));
    await waitFor(() => expect(libraryThumbnailMock).toHaveBeenCalled());
    // Only one IPC call despite two consumers.
    expect(libraryThumbnailMock).toHaveBeenCalledTimes(1);
  });

  it("bounds the cache with LRU eviction under heavy scrolling", async () => {
    // Distinct decode per id so each fetch is independently observable.
    libraryThumbnailMock.mockImplementation((id: string) =>
      Promise.resolve(`data:image/png;base64,${id}`)
    );

    // Scroll past far more captures than the cap holds. The first id (#0)
    // is the least-recently-used and must be evicted; the cache must never
    // exceed its bound no matter how many we stream past. Flush microtasks
    // after each mount so the resolved thumbnail lands in the cache (faster
    // than polling waitFor across hundreds of iterations).
    const TOTAL = 200;
    for (let i = 0; i < TOTAL; i++) {
      const { unmount } = renderHook(() =>
        useThumbnail(null, `/cap/${i}.png`, 480)
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      unmount();
    }

    const size = __thumbnailCacheSizeForTests();
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(160); // capped, not unbounded
    expect(size).toBeLessThan(TOTAL); // eviction happened
    const callsAfterFill = libraryThumbnailMock.mock.calls.length;

    // The most-recent id is still cached → no new IPC on re-mount.
    const recent = renderHook(() =>
      useThumbnail(null, `/cap/${TOTAL - 1}.png`, 480)
    );
    expect(recent.result.current).toBe(
      `data:image/png;base64,/cap/${TOTAL - 1}.png`
    );
    expect(libraryThumbnailMock.mock.calls.length).toBe(callsAfterFill);

    // The oldest id was evicted → re-mounting it triggers a fresh decode.
    const evicted = renderHook(() => useThumbnail(null, `/cap/0.png`, 480));
    await waitFor(() =>
      expect(evicted.result.current).toBe("data:image/png;base64,/cap/0.png")
    );
    expect(libraryThumbnailMock.mock.calls.length).toBe(callsAfterFill + 1);
  }, 30000);

  it("keys grid and list widths separately", async () => {
    libraryThumbnailMock.mockResolvedValue("data:image/png;base64,x");
    renderHook(() => useThumbnail(null, "/tmp/captures/e.png", 480));
    renderHook(() => useThumbnail(null, "/tmp/captures/e.png", 120));
    await waitFor(() => expect(libraryThumbnailMock).toHaveBeenCalledTimes(2));
    expect(libraryThumbnailMock).toHaveBeenCalledWith(
      "/tmp/captures/e.png",
      480
    );
    expect(libraryThumbnailMock).toHaveBeenCalledWith(
      "/tmp/captures/e.png",
      120
    );
  });
});
