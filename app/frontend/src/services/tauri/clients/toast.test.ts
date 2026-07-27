import { beforeEach, describe, expect, it, vi } from "vitest";

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
    toastShow: "clippity://toast/show",
    toastHide: "clippity://toast/hide",
    libraryUpdated: "clippity://library/updated",
    settingsChanged: "clippity://settings/changed",
  },
}));

import {
  emitErrorToast,
  hideToast,
  onToastHide,
  onToastShow,
  resizeToast,
  showCaptureWindow,
  showToast,
} from "./toast";

describe("showToast", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes show_toast with the wrapped payload", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await showToast({ kind: "error", message: "boom" });
    expect(invokeMock).toHaveBeenCalledWith("show_toast", {
      payload: { kind: "error", message: "boom" },
    });
  });

  it("propagates errors from the IPC layer", async () => {
    const boom = new Error("toast: window missing");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(showToast({ kind: "error", message: "x" })).rejects.toBe(boom);
  });
});

describe("emitErrorToast", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("builds a kind: 'error' payload and routes through show_toast", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await emitErrorToast("no monitor found");
    expect(invokeMock).toHaveBeenCalledWith("show_toast", {
      payload: { kind: "error", message: "no monitor found" },
    });
  });
});

describe("hideToast / resizeToast / showCaptureWindow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("hideToast invokes hide_toast with no args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await hideToast();
    expect(invokeMock).toHaveBeenCalledWith("hide_toast");
  });

  it("resizeToast invokes resize_toast with width + height", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await resizeToast(380, 200);
    expect(invokeMock).toHaveBeenCalledWith("resize_toast", {
      width: 380,
      height: 200,
    });
  });

  it("showCaptureWindow invokes show_capture_window", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await showCaptureWindow();
    expect(invokeMock).toHaveBeenCalledWith("show_capture_window");
  });
});

describe("onToastShow / onToastHide", () => {
  beforeEach(() => {
    onMock.mockReset();
  });

  it("subscribes to the toast/show event name", () => {
    const unsubscribe = vi.fn();
    onMock.mockReturnValueOnce(unsubscribe);
    const handler = vi.fn();
    const stop = onToastShow(handler);
    expect(onMock).toHaveBeenCalledWith("clippity://toast/show", handler);
    expect(stop).toBe(unsubscribe);
  });

  it("subscribes to the toast/hide event name with a wrapper handler", () => {
    const unsubscribe = vi.fn();
    onMock.mockReturnValueOnce(unsubscribe);
    const handler = vi.fn();
    const stop = onToastHide(handler);
    // The wrapper is anonymous; we just verify the event name + a
    // function was passed.
    expect(onMock).toHaveBeenCalledTimes(1);
    const [name, wrapper] = onMock.mock.calls[0] ?? [];
    expect(name).toBe("clippity://toast/hide");
    expect(typeof wrapper).toBe("function");
    // And the wrapper itself routes through to the user-provided handler.
    (wrapper as (p: unknown) => void)({ ignored: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(stop).toBe(unsubscribe);
  });
});
