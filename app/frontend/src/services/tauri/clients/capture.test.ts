import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureRequest, CaptureResult } from "./capture";

const invokeMock = vi.fn();
const onMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: (...args: unknown[]) => onMock(...args),
  EVENT_NAMES: {
    onboardingComplete: "clippity://onboarding-complete",
    captureFinished: "clippity://capture/finished",
    overlayShown: "clippity://overlay/shown",
    overlayToggles: "clippity://overlay/toggles",
    libraryUpdated: "clippity://library/updated",
    settingsChanged: "clippity://settings/changed",
  },
}));

import { captureFullscreen, ingestClipboard, onCaptureFinished } from "./capture";

const sampleRequest: CaptureRequest = {
  type: "fullscreen",
  customMode: null,
  toggles: { preview: true, clipboard: false, cursor: false, enhance: false },
  delay: null,
  effect: null,
  share: null,
};

const sampleResult: CaptureResult = {
  id: "cap_1",
  type: "fullscreen",
  customMode: null,
  width: 1920,
  height: 1080,
  path: "/tmp/x.png",
  preview: true,
};

describe("captureFullscreen", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes the capture_fullscreen command with the wrapped request", async () => {
    invokeMock.mockResolvedValueOnce(sampleResult);
    await expect(captureFullscreen(sampleRequest)).resolves.toEqual(
      sampleResult
    );
    expect(invokeMock).toHaveBeenCalledWith("capture_fullscreen", {
      request: sampleRequest,
    });
  });

  it("propagates errors from the IPC layer", async () => {
    const boom = new Error("io: disk full");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(captureFullscreen(sampleRequest)).rejects.toBe(boom);
  });
});

describe("onCaptureFinished", () => {
  beforeEach(() => {
    onMock.mockReset();
  });

  it("subscribes to the capture/finished event name", () => {
    const unsubscribe = vi.fn();
    onMock.mockReturnValueOnce(unsubscribe);
    const handler = vi.fn();
    const stop = onCaptureFinished(handler);
    expect(onMock).toHaveBeenCalledWith("clippity://capture/finished", handler);
    expect(stop).toBe(unsubscribe);
  });
});

describe("ingestClipboard", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes ingest_clipboard with the preview flag", async () => {
    invokeMock.mockResolvedValueOnce({ kind: "empty" });
    await expect(ingestClipboard(true)).resolves.toEqual({ kind: "empty" });
    expect(invokeMock).toHaveBeenCalledWith("ingest_clipboard", {
      preview: true,
    });
  });

  it("returns the image ingest payload verbatim", async () => {
    const payload = { kind: "image", capture: sampleResult };
    invokeMock.mockResolvedValueOnce(payload);
    await expect(ingestClipboard(false)).resolves.toEqual(payload);
    expect(invokeMock).toHaveBeenCalledWith("ingest_clipboard", {
      preview: false,
    });
  });

  it("propagates errors from the IPC layer", async () => {
    const boom = new Error("capture: clipboard open failed");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(ingestClipboard(true)).rejects.toBe(boom);
  });
});
