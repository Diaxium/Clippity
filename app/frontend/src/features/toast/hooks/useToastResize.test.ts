import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resizeToastMock = vi.fn();

vi.mock("@services/tauri/clients/toast", () => ({
  resizeToast: (...args: unknown[]) => resizeToastMock(...args),
}));

import {
  CHROME_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  TOAST_WIDTH,
} from "../constants";
import { useToastResize } from "./useToastResize";

// Per-test ResizeObserver mock that captures the constructor callback
// so we can drive layout changes synchronously.
type ObserverCallback = (
  entries: ResizeObserverEntry[],
  observer: ResizeObserver
) => void;

let observerCallback: ObserverCallback | null = null;
const observeMock = vi.fn();
const disconnectMock = vi.fn();

class RecordingResizeObserver implements ResizeObserver {
  constructor(cb: ObserverCallback) {
    observerCallback = cb;
  }
  observe(target: Element): void {
    observeMock(target);
  }
  unobserve(): void {}
  disconnect(): void {
    disconnectMock();
  }
}

beforeEach(() => {
  resizeToastMock.mockReset();
  observeMock.mockReset();
  disconnectMock.mockReset();
  observerCallback = null;
  globalThis.ResizeObserver =
    RecordingResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  // Restore the test-setup stub.
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver =
    StubResizeObserver as unknown as typeof ResizeObserver;
});

/** A detached div with a controllable `scrollHeight`. */
function makeBody(scrollHeight: number) {
  const el = document.createElement("div");
  const set = (h: number) =>
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => h,
    });
  set(scrollHeight);
  document.body.appendChild(el);
  return { el, setScrollHeight: set };
}

/**
 * Test harness — mounts the hook against an element with a
 * controllable `scrollHeight` so we can verify both the initial
 * resize push and the ResizeObserver-driven follow-ups.
 */
function renderWithScrollHeight(initial: number, chromeHeight?: number) {
  const { el, setScrollHeight } = makeBody(initial);
  const hookResult = renderHook(() => useToastResize(el, chromeHeight));
  return { el, setScrollHeight, ...hookResult };
}

describe("useToastResize", () => {
  it("pushes the initial measured height on mount (clamped + chrome-padded)", () => {
    renderWithScrollHeight(120);
    expect(resizeToastMock).toHaveBeenCalledTimes(1);
    expect(resizeToastMock).toHaveBeenCalledWith(
      TOAST_WIDTH,
      120 + CHROME_HEIGHT
    );
  });

  it("clamps below MIN_HEIGHT", () => {
    renderWithScrollHeight(10);
    expect(resizeToastMock).toHaveBeenCalledWith(TOAST_WIDTH, MIN_HEIGHT);
  });

  it("clamps above MAX_HEIGHT", () => {
    renderWithScrollHeight(2000);
    expect(resizeToastMock).toHaveBeenCalledWith(TOAST_WIDTH, MAX_HEIGHT);
  });

  it("re-pushes when ResizeObserver fires with a different measured height", () => {
    const { el, setScrollHeight } = renderWithScrollHeight(120);
    expect(resizeToastMock).toHaveBeenCalledTimes(1);

    setScrollHeight(200);
    act(() => {
      observerCallback?.(
        [{ target: el } as unknown as ResizeObserverEntry],
        {} as ResizeObserver
      );
    });
    expect(resizeToastMock).toHaveBeenCalledTimes(2);
    expect(resizeToastMock).toHaveBeenLastCalledWith(
      TOAST_WIDTH,
      200 + CHROME_HEIGHT
    );
  });

  it("skips the IPC when the new measured height matches the last (idempotent)", () => {
    const { el } = renderWithScrollHeight(120);
    expect(resizeToastMock).toHaveBeenCalledTimes(1);

    // Trigger the observer with the same height — should NOT call resizeToast again.
    act(() => {
      observerCallback?.(
        [{ target: el } as unknown as ResizeObserverEntry],
        {} as ResizeObserver
      );
    });
    expect(resizeToastMock).toHaveBeenCalledTimes(1);
  });

  it("honors an explicit chrome height of 0 (recording HUD renders bare)", () => {
    renderWithScrollHeight(260, 0);
    // No outer card padding to add back — the window matches the body.
    expect(resizeToastMock).toHaveBeenCalledWith(TOAST_WIDTH, 260);
  });

  it("stays idle until a body exists, then arms on the element it is handed", () => {
    // The regression this guards: the body only mounts once a toast is on
    // screen, so the hook's first render always sees `null`. Keyed on a
    // ref object (stable identity) the effect never re-ran and the
    // observer was never attached for any toast after mount.
    const { el, setScrollHeight } = makeBody(120);
    const { rerender } = renderHook(
      ({ body }: { body: HTMLElement | null }) => useToastResize(body),
      { initialProps: { body: null as HTMLElement | null } }
    );
    expect(resizeToastMock).not.toHaveBeenCalled();
    expect(observeMock).not.toHaveBeenCalled();

    rerender({ body: el });
    expect(resizeToastMock).toHaveBeenCalledWith(
      TOAST_WIDTH,
      120 + CHROME_HEIGHT
    );
    expect(observeMock).toHaveBeenCalledWith(el);

    setScrollHeight(200);
    act(() => {
      observerCallback?.(
        [{ target: el } as unknown as ResizeObserverEntry],
        {} as ResizeObserver
      );
    });
    expect(resizeToastMock).toHaveBeenLastCalledWith(
      TOAST_WIDTH,
      200 + CHROME_HEIGHT
    );
  });

  it("disconnects the observer on unmount", () => {
    const { unmount } = renderWithScrollHeight(120);
    expect(disconnectMock).not.toHaveBeenCalled();
    unmount();
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});
