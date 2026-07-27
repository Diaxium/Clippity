import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CountdownStartEvent } from "@services/tauri/clients/countdown";

const finishCountdownMock = vi.fn();
const onCountdownStartMock = vi.fn();
const onCountdownCancelledMock = vi.fn();
let lastStartHandler: ((event: CountdownStartEvent) => void) | null = null;
let lastCancelledHandler: (() => void) | null = null;

vi.mock("@services/tauri/clients/countdown", () => ({
  finishCountdown: () => finishCountdownMock(),
  onCountdownStart: (handler: (event: CountdownStartEvent) => void) => {
    lastStartHandler = handler;
    onCountdownStartMock(handler);
    return () => {
      if (lastStartHandler === handler) lastStartHandler = null;
    };
  },
  onCountdownCancelled: (handler: () => void) => {
    lastCancelledHandler = handler;
    onCountdownCancelledMock(handler);
    return () => {
      if (lastCancelledHandler === handler) lastCancelledHandler = null;
    };
  },
}));

import { useCountdown } from "./useCountdown";

describe("useCountdown", () => {
  beforeEach(() => {
    finishCountdownMock.mockReset();
    onCountdownStartMock.mockReset();
    onCountdownCancelledMock.mockReset();
    lastStartHandler = null;
    lastCancelledHandler = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts idle: remaining=null, active=false", () => {
    const { result } = renderHook(() => useCountdown());
    expect(result.current.remaining).toBeNull();
    expect(result.current.active).toBe(false);
    expect(result.current.total).toBe(0);
  });

  it("subscribes to start + cancelled events on mount", () => {
    renderHook(() => useCountdown());
    expect(onCountdownStartMock).toHaveBeenCalledTimes(1);
    expect(onCountdownCancelledMock).toHaveBeenCalledTimes(1);
  });

  it("flips to active with the requested seconds when the start event lands", () => {
    const { result } = renderHook(() => useCountdown());
    act(() => {
      lastStartHandler?.({ seconds: 5 });
    });
    expect(result.current.active).toBe(true);
    expect(result.current.remaining).toBe(5);
    expect(result.current.total).toBe(5);
    expect(result.current.progress).toBe(0);
  });

  it("resets to idle when the backend emits countdown/cancelled", () => {
    const { result } = renderHook(() => useCountdown());
    act(() => {
      lastStartHandler?.({ seconds: 3 });
    });
    expect(result.current.active).toBe(true);
    // Backend global-Esc handler ran cancel and emitted cancelled.
    act(() => {
      lastCancelledHandler?.();
    });
    expect(result.current.active).toBe(false);
    expect(result.current.remaining).toBeNull();
    // The hook must NOT echo finish back to the backend on cancel.
    expect(finishCountdownMock).not.toHaveBeenCalled();
  });

  it("ignores a cancelled event while idle (no throw, stays idle)", () => {
    const { result } = renderHook(() => useCountdown());
    act(() => {
      lastCancelledHandler?.();
    });
    expect(result.current.active).toBe(false);
    expect(finishCountdownMock).not.toHaveBeenCalled();
  });
});
