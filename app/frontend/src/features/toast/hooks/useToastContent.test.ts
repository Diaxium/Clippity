import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToastShowEvent } from "@services/tauri/clients/toast";

// Capture the latest handler each subscriber registers so the test
// can drive a TOAST_SHOW / TOAST_HIDE emit manually.
let showHandler: ((e: ToastShowEvent) => void) | null = null;
let hideHandler: (() => void) | null = null;
const showUnsub = vi.fn();
const hideUnsub = vi.fn();
const hideToastMock = vi.fn();

vi.mock("@services/tauri/clients/toast", () => ({
  onToastShow: (cb: (e: ToastShowEvent) => void) => {
    showHandler = cb;
    return showUnsub;
  },
  onToastHide: (cb: () => void) => {
    hideHandler = cb;
    return hideUnsub;
  },
  hideToast: (...args: unknown[]) => hideToastMock(...args),
}));

import { EXIT_DURATION_MS, RECONCILE_GRACE_MS } from "../constants";
import { useToastContent } from "./useToastContent";

describe("useToastContent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    showHandler = null;
    hideHandler = null;
    showUnsub.mockReset();
    hideUnsub.mockReset();
    hideToastMock.mockReset();
    // The hook awaits the hide before dropping its content, so the IPC
    // stub has to be thenable.
    hideToastMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initial state has no event and isn't exiting", () => {
    const { result } = renderHook(() => useToastContent());
    expect(result.current.event).toBeNull();
    expect(result.current.exiting).toBe(false);
  });

  it("subscribes to TOAST_SHOW + TOAST_HIDE on mount", () => {
    renderHook(() => useToastContent());
    expect(showHandler).toBeInstanceOf(Function);
    expect(hideHandler).toBeInstanceOf(Function);
  });

  it("captures a TOAST_SHOW payload into event", () => {
    const { result } = renderHook(() => useToastContent());
    const payload: ToastShowEvent = {
      kind: "error",
      message: "boom",
      durationMs: 6000,
    };
    act(() => showHandler!(payload));
    expect(result.current.event).toEqual(payload);
    expect(result.current.exiting).toBe(false);
  });

  it("clears event on TOAST_HIDE without playing exit animation", () => {
    const { result } = renderHook(() => useToastContent());
    act(() =>
      showHandler!({ kind: "error", message: "boom", durationMs: 6000 })
    );
    expect(result.current.event).not.toBeNull();
    act(() => hideHandler!());
    expect(result.current.event).toBeNull();
    expect(result.current.exiting).toBe(false);
  });

  it("dismiss() flips exiting=true; after EXIT_DURATION_MS, hideToast fires and event clears", async () => {
    const { result } = renderHook(() => useToastContent());
    act(() =>
      showHandler!({ kind: "error", message: "boom", durationMs: 6000 })
    );

    act(() => result.current.dismiss());
    expect(result.current.exiting).toBe(true);
    expect(result.current.event).not.toBeNull();
    expect(hideToastMock).not.toHaveBeenCalled();

    // The hide is requested first and the content is still up while the
    // IPC is in flight — clearing first would blank the window for the
    // length of the round-trip, and forever if it never lands.
    act(() => {
      vi.advanceTimersByTime(EXIT_DURATION_MS);
    });
    expect(hideToastMock).toHaveBeenCalledTimes(1);
    expect(result.current.event).not.toBeNull();

    await act(async () => {});
    expect(result.current.exiting).toBe(false);
    expect(result.current.event).toBeNull();
    expect(hideToastMock).toHaveBeenCalledTimes(1);
  });

  it("still clears its content when the hide IPC rejects", async () => {
    hideToastMock.mockRejectedValue(new Error("ipc down"));
    const { result } = renderHook(() => useToastContent());
    act(() =>
      showHandler!({ kind: "error", message: "boom", durationMs: 6000 })
    );
    act(() => result.current.dismiss());

    await act(async () => {
      vi.advanceTimersByTime(EXIT_DURATION_MS);
    });
    expect(result.current.event).toBeNull();

    // …and the failed hide re-arms the reconciler, which retries.
    await act(async () => {
      vi.advanceTimersByTime(RECONCILE_GRACE_MS);
    });
    expect(hideToastMock).toHaveBeenCalledTimes(2);
  });

  it("hides a window left holding no content (the blank-toast repair)", async () => {
    // Models a `toast/show` whose payload never arrived — the backend
    // revealed the window, this hook has nothing, and before the
    // reconciler existed nothing could ever hide it again.
    renderHook(() => useToastContent());
    expect(hideToastMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(RECONCILE_GRACE_MS);
    });
    expect(hideToastMock).toHaveBeenCalledTimes(1);
  });

  it("does not hide when a toast arrives inside the grace period", async () => {
    const { result } = renderHook(() => useToastContent());

    act(() => vi.advanceTimersByTime(RECONCILE_GRACE_MS - 20));
    act(() =>
      showHandler!({ kind: "error", message: "boom", durationMs: 6000 })
    );

    await act(async () => {
      vi.advanceTimersByTime(RECONCILE_GRACE_MS);
    });
    expect(hideToastMock).not.toHaveBeenCalled();
    expect(result.current.event).not.toBeNull();
  });

  it("re-arms the reconciler for each new empty stretch", async () => {
    const { result } = renderHook(() => useToastContent());
    await act(async () => vi.advanceTimersByTime(RECONCILE_GRACE_MS));
    expect(hideToastMock).toHaveBeenCalledTimes(1);

    // A toast lands and is then cleared by the backend's own hide event
    // (e.g. `stop_recording`) — the next empty stretch must be able to
    // ask again rather than staying latched from the first.
    act(() =>
      showHandler!({
        kind: "recorder",
        format: "mp4",
        microphone: false,
        system: false,
        durationMs: 0,
      })
    );
    act(() => hideHandler!());
    expect(result.current.event).toBeNull();

    await act(async () => vi.advanceTimersByTime(RECONCILE_GRACE_MS));
    expect(hideToastMock).toHaveBeenCalledTimes(2);
  });

  it("reports canAnimate=false for a toast that arrives on a hidden page", () => {
    // rAF doesn't run while the page is hidden, so an entry animation
    // would park the card on its opacity-0 keyframe with no frame ever
    // coming to advance it — a visible window with invisible content.
    const hidden = vi.spyOn(document, "hidden", "get");
    const { result } = renderHook(() => useToastContent());
    expect(result.current.canAnimate).toBe(true);

    hidden.mockReturnValue(true);
    act(() =>
      showHandler!({ kind: "error", message: "boom", durationMs: 6000 })
    );
    expect(result.current.canAnimate).toBe(false);

    hidden.mockReturnValue(false);
    act(() =>
      showHandler!({ kind: "error", message: "again", durationMs: 6000 })
    );
    expect(result.current.canAnimate).toBe(true);
    hidden.mockRestore();
  });

  it("tracks visibility live, so an exit gets the current answer", () => {
    // The toast that mounted while visible may still be on screen when
    // the page stops being composited; its exit has to know that.
    const hidden = vi.spyOn(document, "hidden", "get");
    const { result } = renderHook(() => useToastContent());
    act(() =>
      showHandler!({ kind: "error", message: "boom", durationMs: 6000 })
    );
    expect(result.current.canAnimate).toBe(true);

    hidden.mockReturnValue(true);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.canAnimate).toBe(false);
    hidden.mockRestore();
  });

  it("unmount cleans up both event listeners", () => {
    const { unmount } = renderHook(() => useToastContent());
    unmount();
    expect(showUnsub).toHaveBeenCalledTimes(1);
    expect(hideUnsub).toHaveBeenCalledTimes(1);
  });

  it("a second TOAST_SHOW replaces the current event without exit animation", () => {
    const { result } = renderHook(() => useToastContent());
    act(() =>
      showHandler!({ kind: "error", message: "first", durationMs: 1000 })
    );
    expect(result.current.event?.kind).toBe("error");
    expect(
      result.current.event && "message" in result.current.event
        ? result.current.event.message
        : null
    ).toBe("first");

    act(() =>
      showHandler!({ kind: "error", message: "second", durationMs: 1000 })
    );
    expect(
      result.current.event && "message" in result.current.event
        ? result.current.event.message
        : null
    ).toBe("second");
    expect(result.current.exiting).toBe(false);
  });
});
