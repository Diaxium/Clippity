import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INITIAL_RENDERED,
  RENDER_STEP,
  useProgressiveRender,
} from "./useProgressiveRender";

// Local alias for the DOM-global callback signature, matching the
// convention in `useThumbnail.test.ts` (satisfies ESLint's `no-undef`).
type IOCallback = (
  entries: IntersectionObserverEntry[],
  observer: IntersectionObserver
) => void;

let ioCallback: IOCallback | null = null;
const observeMock = vi.fn();
const disconnectMock = vi.fn();

class RecordingIO implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
  constructor(cb: IOCallback) {
    ioCallback = cb;
  }
  observe = (el: Element) => observeMock(el);
  unobserve = () => {};
  disconnect = () => disconnectMock();
  takeRecords = () => [];
}

const realIO = globalThis.IntersectionObserver;

beforeEach(() => {
  observeMock.mockReset();
  disconnectMock.mockReset();
  ioCallback = null;
  globalThis.IntersectionObserver =
    RecordingIO as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  globalThis.IntersectionObserver = realIO;
  vi.clearAllMocks();
});

/** Mount the sentinel the hook handed back. */
function attachSentinel(ref: (el: HTMLElement | null) => void) {
  act(() => ref(document.createElement("div")));
}

/** Simulate the sentinel scrolling into view. */
function reachSentinel() {
  act(() => {
    ioCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    );
  });
}

describe("useProgressiveRender", () => {
  it("mounts only the first batch of a long list", () => {
    const { result } = renderHook(() => useProgressiveRender(10_000, "k"));
    expect(result.current.count).toBe(INITIAL_RENDERED);
    expect(result.current.hasMore).toBe(true);
  });

  it("never reports more than the list holds", () => {
    const { result } = renderHook(() => useProgressiveRender(7, "k"));
    expect(result.current.count).toBe(7);
    expect(result.current.hasMore).toBe(false);
  });

  it("grows by a step each time the sentinel comes into view", () => {
    const { result } = renderHook(() => useProgressiveRender(10_000, "k"));
    attachSentinel(result.current.sentinelRef);
    expect(observeMock).toHaveBeenCalledTimes(1);

    reachSentinel();
    expect(result.current.count).toBe(INITIAL_RENDERED + RENDER_STEP);

    reachSentinel();
    expect(result.current.count).toBe(INITIAL_RENDERED + 2 * RENDER_STEP);
  });

  it("stops exactly at the end of the list", () => {
    const total = INITIAL_RENDERED + 10;
    const { result } = renderHook(() => useProgressiveRender(total, "k"));
    attachSentinel(result.current.sentinelRef);

    reachSentinel();
    expect(result.current.count).toBe(total);
    expect(result.current.hasMore).toBe(false);
  });

  it("restarts at the top when the list identity changes", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useProgressiveRender(10_000, key),
      { initialProps: { key: "all|newest" } }
    );
    attachSentinel(result.current.sentinelRef);
    reachSentinel();
    expect(result.current.count).toBe(INITIAL_RENDERED + RENDER_STEP);

    // A different scope / sort / search is a different list.
    rerender({ key: "favorites|newest" });
    expect(result.current.count).toBe(INITIAL_RENDERED);
  });

  it("keeps the budget when the same list re-renders", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useProgressiveRender(10_000, key),
      { initialProps: { key: "all|newest" } }
    );
    attachSentinel(result.current.sentinelRef);
    reachSentinel();

    rerender({ key: "all|newest" });
    expect(result.current.count).toBe(INITIAL_RENDERED + RENDER_STEP);
  });

  it("stops observing once the whole list is mounted", () => {
    const total = INITIAL_RENDERED + 1;
    const { result } = renderHook(() => useProgressiveRender(total, "k"));
    attachSentinel(result.current.sentinelRef);

    reachSentinel();
    expect(result.current.hasMore).toBe(false);
    expect(disconnectMock).toHaveBeenCalled();
  });

  it("disconnects the observer on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useProgressiveRender(10_000, "k")
    );
    attachSentinel(result.current.sentinelRef);
    unmount();
    expect(disconnectMock).toHaveBeenCalled();
  });

  it("mounts the whole list where visibility can't be observed", () => {
    // No IntersectionObserver → degrade to the pre-P5 behaviour rather
    // than silently truncating the grid.
    globalThis.IntersectionObserver =
      undefined as unknown as typeof IntersectionObserver;
    const { result } = renderHook(() => useProgressiveRender(10_000, "k"));
    attachSentinel(result.current.sentinelRef);
    expect(result.current.count).toBe(10_000);
    expect(result.current.hasMore).toBe(false);
  });
});
