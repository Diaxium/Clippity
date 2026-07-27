import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const onMock = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn() }));

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: (...args: unknown[]) => onMock(...args),
  EVENT_NAMES: {
    recordingTick: "clippity://recording/tick",
    recordingPreview: "clippity://recording/preview",
    recordingAutoStop: "clippity://recording/auto-stop",
    overlayScrollDirection: "clippity://overlay/scroll-direction",
  },
}));

import {
  startPanoramicCapture,
  startScrollCapture,
  stopScrollCapture,
} from "./scroll";

const rect = { x: 10, y: 20, width: 800, height: 600 };

beforeEach(() => {
  invokeMock.mockReset();
});

describe("startScrollCapture", () => {
  it("invokes start_scroll_capture with rect + direction + flags", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await startScrollCapture(rect, "down", true, false);
    expect(invokeMock).toHaveBeenCalledWith("start_scroll_capture", {
      rect,
      direction: "down",
      clipboard: true,
      preview: false,
    });
  });
});

describe("startPanoramicCapture", () => {
  it("invokes start_panoramic_capture with rect + direction + flags", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await startPanoramicCapture(rect, "right", false, true);
    expect(invokeMock).toHaveBeenCalledWith("start_panoramic_capture", {
      rect,
      direction: "right",
      clipboard: false,
      preview: true,
    });
  });

  it("propagates IPC errors", async () => {
    const boom = new Error("a recording is already in progress");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(startPanoramicCapture(rect, "up", false, false)).rejects.toBe(
      boom
    );
  });
});

describe("stopScrollCapture", () => {
  it("invokes stop_scroll_capture with the discard flag and returns the result", async () => {
    const result = {
      id: "cap_1",
      width: 800,
      height: 4200,
      path: "/x.png",
      preview: true,
    };
    invokeMock.mockResolvedValueOnce(result);
    const out = await stopScrollCapture(false);
    expect(invokeMock).toHaveBeenCalledWith("stop_scroll_capture", {
      discard: false,
    });
    expect(out).toEqual(result);
  });
});
