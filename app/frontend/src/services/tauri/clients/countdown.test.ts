import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const onMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: (...args: unknown[]) => onMock(...args),
  EVENT_NAMES: {
    countdownStart: "clippity://countdown/start",
  },
}));

import {
  cancelCountdown,
  finishCountdown,
  onCountdownStart,
  startCountdown,
} from "./countdown";

describe("startCountdown", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("wraps seconds in { request: { seconds } } and invokes start_countdown", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await startCountdown(5);
    expect(invokeMock).toHaveBeenCalledWith("start_countdown", {
      request: { seconds: 5 },
    });
  });

  it("propagates IPC errors", async () => {
    const boom = new Error("countdown seconds above the supported maximum");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(startCountdown(999)).rejects.toBe(boom);
  });
});

describe("cancelCountdown", () => {
  it("invokes cancel_countdown with no args", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(undefined);
    await cancelCountdown();
    expect(invokeMock).toHaveBeenCalledWith("cancel_countdown");
  });
});

describe("finishCountdown", () => {
  it("invokes finish_countdown with no args", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(undefined);
    await finishCountdown();
    expect(invokeMock).toHaveBeenCalledWith("finish_countdown");
  });
});

describe("onCountdownStart", () => {
  beforeEach(() => {
    onMock.mockReset();
  });

  it("subscribes to clippity://countdown/start", () => {
    const unsubscribe = vi.fn();
    onMock.mockReturnValueOnce(unsubscribe);
    const handler = vi.fn();
    const stop = onCountdownStart(handler);
    expect(onMock).toHaveBeenCalledWith("clippity://countdown/start", handler);
    expect(stop).toBe(unsubscribe);
  });
});
