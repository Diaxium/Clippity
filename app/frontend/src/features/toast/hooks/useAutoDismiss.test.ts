import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutoDismiss } from "./useAutoDismiss";

// Drive performance.now() ourselves so the rAF loop's elapsed math
// is deterministic. We bump this in lock-step with fake timers.
let nowMock = 0;
const realNow = performance.now;

// Track rAF schedules so we can flush them between fake-timer ticks.
type RafCallback = (t: number) => void;
let rafCallbacks: RafCallback[] = [];

beforeEach(() => {
  // Fake only the timeout surface. This test supplies its own rAF/cAF
  // and performance.now below, and letting the fake clock install those
  // too means its teardown removes `window.cancelAnimationFrame` out
  // from under React's unmount cleanup, which calls it.
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
    ],
  });
  nowMock = 0;
  performance.now = () => nowMock;
  rafCallbacks = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCallbacks.push(cb);
    return rafCallbacks.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    // Drop the scheduled callback; tests that need to assert "rAF ran
    // again" check rafCallbacks.length before/after.
    if (typeof id === "number" && id > 0 && id <= rafCallbacks.length) {
      rafCallbacks[id - 1] = () => {};
    }
  });
});

afterEach(() => {
  performance.now = realNow;
  vi.useRealTimers();
});

/** Advance fake time + flush queued rAF callbacks so the hook's
 *  progress tick can update derived state. */
function advance(ms: number): void {
  nowMock += ms;
  vi.advanceTimersByTime(ms);
  // Flush whichever rAF was queued; the hook will queue a fresh one
  // each tick until progress hits 0.
  const queued = rafCallbacks;
  rafCallbacks = [];
  for (const cb of queued) cb(nowMock);
}

describe("useAutoDismiss", () => {
  it("sticky (durationMs <= 0): progress stays at 1, onExpire never fires", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() =>
      useAutoDismiss({
        active: true,
        durationMs: 0,
        hovered: false,
        onExpire,
      })
    );
    act(() => advance(5000));
    expect(result.current.progress).toBe(1);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("active=false: no timer, no progress drop", () => {
    const onExpire = vi.fn();
    const { result } = renderHook(() =>
      useAutoDismiss({
        active: false,
        durationMs: 6000,
        hovered: false,
        onExpire,
      })
    );
    act(() => advance(6500));
    expect(result.current.progress).toBe(1);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("fires onExpire after the full duration when not hovered", () => {
    const onExpire = vi.fn();
    renderHook(() =>
      useAutoDismiss({
        active: true,
        durationMs: 1000,
        hovered: false,
        onExpire,
      })
    );
    act(() => advance(999));
    expect(onExpire).not.toHaveBeenCalled();
    act(() => advance(2));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("hovered=true: pauses the timer; un-hovering resumes from remainder", () => {
    const onExpire = vi.fn();
    const { rerender } = renderHook(
      ({ hovered }: { hovered: boolean }) =>
        useAutoDismiss({
          active: true,
          durationMs: 1000,
          hovered,
          onExpire,
        }),
      { initialProps: { hovered: false } }
    );

    // Burn 300ms with the timer running.
    act(() => advance(300));

    // Hover — timer should clear; further time should not fire onExpire.
    rerender({ hovered: true });
    act(() => advance(2000));
    expect(onExpire).not.toHaveBeenCalled();

    // Un-hover — timer resumes from ~700ms remaining. After ~700ms it
    // should expire.
    rerender({ hovered: false });
    act(() => advance(699));
    expect(onExpire).not.toHaveBeenCalled();
    act(() => advance(2));
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
