import { beforeEach, describe, expect, it, vi } from "vitest";

const captureFullscreenMock = vi.fn();
const beginRegionCaptureMock = vi.fn();
const emitOverlayTogglesMock = vi.fn();
const emitErrorToastMock = vi.fn();
const startCountdownMock = vi.fn();
const ingestClipboardMock = vi.fn();
const ensureObjectModelMock = vi.fn();
// Countdown subscriber capture — the workflow calls onCountdownFinished /
// onCountdownCancelled and races their handlers. Each test that
// exercises the delay branch picks which one to fire via these refs.
let pendingFinishedHandler: (() => void) | null = null;
let pendingCancelledHandler: (() => void) | null = null;

vi.mock("@services/tauri/clients/capture", () => ({
  captureFullscreen: (...args: unknown[]) => captureFullscreenMock(...args),
  ingestClipboard: (...args: unknown[]) => ingestClipboardMock(...args),
  onCaptureFinished: vi.fn(),
}));

vi.mock("@services/tauri/clients/overlay", () => ({
  beginRegionCapture: (...args: unknown[]) => beginRegionCaptureMock(...args),
  emitOverlayToggles: (...args: unknown[]) => emitOverlayTogglesMock(...args),
  cancelRegionCapture: vi.fn(),
  finishRegionCapture: vi.fn(),
  getDesktopSnapshot: vi.fn(),
  onOverlayShown: vi.fn(),
  onOverlayToggles: vi.fn(),
}));

vi.mock("@services/tauri/clients/models", () => ({
  ensureObjectModel: (...args: unknown[]) => ensureObjectModelMock(...args),
}));

vi.mock("@services/tauri/clients/scroll", () => ({
  emitOverlayScrollDirection: vi.fn(),
}));

vi.mock("@services/tauri/clients/countdown", () => ({
  startCountdown: (...args: unknown[]) => startCountdownMock(...args),
  cancelCountdown: vi.fn(),
  finishCountdown: vi.fn(),
  onCountdownStart: vi.fn(),
  onCountdownFinished: (handler: () => void) => {
    pendingFinishedHandler = handler;
    return () => {
      if (pendingFinishedHandler === handler) pendingFinishedHandler = null;
    };
  },
  onCountdownCancelled: (handler: () => void) => {
    pendingCancelledHandler = handler;
    return () => {
      if (pendingCancelledHandler === handler) pendingCancelledHandler = null;
    };
  },
}));

vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (...args: unknown[]) => emitErrorToastMock(...args),
  // Other exports are mocked here too so an inadvertent import doesn't
  // pull the real module's invoke wrapper.
  showToast: vi.fn(),
  hideToast: vi.fn(),
  resizeToast: vi.fn(),
  showCaptureWindow: vi.fn(),
  onToastShow: vi.fn(),
  onToastHide: vi.fn(),
}));

import type * as TauriModule from "@services/tauri";

vi.mock("@services/tauri", async () => {
  const actual = await vi.importActual<typeof TauriModule>("@services/tauri");
  return {
    invoke: vi.fn(),
    on: vi.fn(),
    isTauriContext: () => false,
    TauriCommandError: actual.TauriCommandError,
    EVENT_NAMES: {
      captureFinished: "clippity://capture/finished",
      overlayShown: "clippity://overlay/shown",
      overlayToggles: "clippity://overlay/toggles",
      toastShow: "clippity://toast/show",
      toastHide: "clippity://toast/hide",
    },
  };
});

import { renderHook, act } from "@testing-library/react";

import { TauriCommandError } from "@services/tauri";

import { useCaptureStore } from "../state/captureStore";
import { useCaptureWorkflow } from "./useCaptureWorkflow";

const initialState = useCaptureStore.getState();

describe("useCaptureWorkflow — fullscreen branch", () => {
  beforeEach(() => {
    captureFullscreenMock.mockReset();
    beginRegionCaptureMock.mockReset();
    emitOverlayTogglesMock.mockReset();
    emitErrorToastMock.mockReset();
    startCountdownMock.mockReset();
    pendingFinishedHandler = null;
    pendingCancelledHandler = null;
    useCaptureStore.setState(initialState, true);
    // Switch off the new region default so these tests still exercise
    // the fullscreen branch.
    useCaptureStore.getState().setCaptureType("fullscreen");
  });

  it("returns the backend's CaptureResult on success", async () => {
    const expected = {
      id: "cap_1",
      type: "fullscreen" as const,
      customMode: null,
      width: 1920,
      height: 1080,
      path: "/tmp/x.png",
    };
    captureFullscreenMock.mockResolvedValueOnce(expected);

    const { result } = renderHook(() => useCaptureWorkflow());
    let got: unknown;
    await act(async () => {
      got = await result.current.trigger();
    });
    expect(got).toEqual(expected);
    // Success path must not fire an error toast.
    expect(emitErrorToastMock).not.toHaveBeenCalled();
  });

  it("calls captureFullscreen with the built request (no delay)", async () => {
    captureFullscreenMock.mockResolvedValueOnce({});

    useCaptureStore.getState().setOption("clipboard", true);
    // Explicitly keep delay off so this test exercises the direct
    // capture path without racing the countdown event listeners.
    useCaptureStore.getState().setDelayEnabled(false);

    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });

    expect(captureFullscreenMock).toHaveBeenCalledTimes(1);
    const firstCall = captureFullscreenMock.mock.calls[0];
    expect(firstCall?.[0]).toEqual({
      type: "fullscreen",
      customMode: null,
      toggles: {
        preview: true,
        clipboard: true,
        cursor: false,
        enhance: false,
      },
      delay: null,
      effect: null,
      share: null,
    });
    // Direct path must not touch the countdown HUD.
    expect(startCountdownMock).not.toHaveBeenCalled();
  });

  it("emits overlay toggles before dispatching", async () => {
    captureFullscreenMock.mockResolvedValueOnce({});
    useCaptureStore.getState().setOption("cursor", true);

    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });

    expect(emitOverlayTogglesMock).toHaveBeenCalledWith({
      preview: true,
      clipboard: false,
      cursor: true,
      enhance: false,
    });
  });

  it("emits an error toast for a TauriCommandError and returns null", async () => {
    const wireError = new TauriCommandError({
      code: "capture",
      message: "no monitor found",
    });
    captureFullscreenMock.mockRejectedValueOnce(wireError);

    const { result } = renderHook(() => useCaptureWorkflow());
    let got: unknown;
    await act(async () => {
      got = await result.current.trigger();
    });
    expect(got).toBeNull();
    expect(emitErrorToastMock).toHaveBeenCalledTimes(1);
    expect(emitErrorToastMock).toHaveBeenCalledWith("no monitor found");
  });

  it("emits a generic error toast for non-Error throws", async () => {
    captureFullscreenMock.mockRejectedValueOnce("opaque");

    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(emitErrorToastMock).toHaveBeenCalledWith("Capture failed.");
  });
});

describe("useCaptureWorkflow — delay branch", () => {
  beforeEach(() => {
    captureFullscreenMock.mockReset();
    beginRegionCaptureMock.mockReset();
    emitOverlayTogglesMock.mockReset();
    emitErrorToastMock.mockReset();
    startCountdownMock.mockReset();
    pendingFinishedHandler = null;
    pendingCancelledHandler = null;
    useCaptureStore.setState(initialState, true);
    useCaptureStore.getState().setCaptureType("fullscreen");
    useCaptureStore.getState().setDelayEnabled(true);
    useCaptureStore.getState().setDelaySeconds(3);
  });

  it("fires startCountdown(seconds) before the capture call", async () => {
    captureFullscreenMock.mockResolvedValueOnce({});
    startCountdownMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useCaptureWorkflow());
    const triggerPromise = result.current.trigger();
    // Let the trigger reach the await on `startCountdown` and then
    // the await on the outcome race.
    await Promise.resolve();
    await Promise.resolve();
    expect(startCountdownMock).toHaveBeenCalledWith(3);
    // Capture mustn't fire until the finished handler resolves.
    expect(captureFullscreenMock).not.toHaveBeenCalled();

    await act(async () => {
      pendingFinishedHandler?.();
      await triggerPromise;
    });
    expect(captureFullscreenMock).toHaveBeenCalledTimes(1);
  });

  it("bails without capturing when the countdown is cancelled", async () => {
    startCountdownMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useCaptureWorkflow());
    let got: unknown;
    const triggerPromise = (async () => {
      got = await result.current.trigger();
    })();
    await Promise.resolve();
    await Promise.resolve();
    await act(async () => {
      pendingCancelledHandler?.();
      await triggerPromise;
    });
    expect(captureFullscreenMock).not.toHaveBeenCalled();
    expect(got).toBeNull();
    expect(emitErrorToastMock).not.toHaveBeenCalled();
  });

  it("emits an error toast when startCountdown fails", async () => {
    startCountdownMock.mockRejectedValueOnce(
      new TauriCommandError({
        code: "countdown",
        message: "countdown seconds above the supported maximum",
      })
    );

    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(emitErrorToastMock).toHaveBeenCalledWith(
      "countdown seconds above the supported maximum"
    );
    expect(captureFullscreenMock).not.toHaveBeenCalled();
  });
});

describe("useCaptureWorkflow — region branch", () => {
  beforeEach(() => {
    captureFullscreenMock.mockReset();
    beginRegionCaptureMock.mockReset();
    emitOverlayTogglesMock.mockReset();
    emitErrorToastMock.mockReset();
    startCountdownMock.mockReset();
    pendingFinishedHandler = null;
    pendingCancelledHandler = null;
    useCaptureStore.setState(initialState, true);
    // Region is the default — no setCaptureType needed.
  });

  it("calls beginRegionCapture('region') and returns null", async () => {
    beginRegionCaptureMock.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useCaptureWorkflow());
    let got: unknown;
    await act(async () => {
      got = await result.current.trigger();
    });
    expect(beginRegionCaptureMock).toHaveBeenCalledWith("region");
    expect(captureFullscreenMock).not.toHaveBeenCalled();
    expect(got).toBeNull();
    expect(emitErrorToastMock).not.toHaveBeenCalled();
  });

  it("emits an error toast on beginRegionCapture failure", async () => {
    beginRegionCaptureMock.mockRejectedValueOnce(
      new TauriCommandError({ code: "overlay", message: "no monitors found" })
    );

    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(emitErrorToastMock).toHaveBeenCalledWith("no monitors found");
  });
});

describe("useCaptureWorkflow — window + custom branches", () => {
  beforeEach(() => {
    captureFullscreenMock.mockReset();
    beginRegionCaptureMock.mockReset();
    emitOverlayTogglesMock.mockReset();
    emitErrorToastMock.mockReset();
    startCountdownMock.mockReset();
    ensureObjectModelMock.mockReset();
    pendingFinishedHandler = null;
    pendingCancelledHandler = null;
    useCaptureStore.setState(initialState, true);
  });

  it("window branch opens the overlay in window mode and returns null", async () => {
    beginRegionCaptureMock.mockResolvedValueOnce(undefined);
    useCaptureStore.getState().setCaptureType("window");
    const { result } = renderHook(() => useCaptureWorkflow());
    let got: unknown;
    await act(async () => {
      got = await result.current.trigger();
    });
    expect(beginRegionCaptureMock).toHaveBeenCalledWith("window");
    expect(captureFullscreenMock).not.toHaveBeenCalled();
    expect(got).toBeNull();
    expect(emitErrorToastMock).not.toHaveBeenCalled();
  });

  it("custom branch with no mode selected is a no-op", async () => {
    useCaptureStore.getState().setCaptureType("custom");
    const { result } = renderHook(() => useCaptureWorkflow());
    let got: unknown;
    await act(async () => {
      got = await result.current.trigger();
    });
    expect(got).toBeNull();
    expect(captureFullscreenMock).not.toHaveBeenCalled();
    expect(beginRegionCaptureMock).not.toHaveBeenCalled();
  });

  it.each([
    ["multi-area", "multi-area"],
    ["color-picker", "color-pick"],
    ["palette-capture", "palette"],
    ["grab-text", "grab-text"],
    ["scrolling-window", "scrolling"],
    ["panoramic", "panoramic"],
  ] as const)(
    "custom mode %s opens the overlay in %s mode",
    async (customMode, overlayMode) => {
      beginRegionCaptureMock.mockResolvedValueOnce(undefined);
      useCaptureStore.getState().setCaptureType("custom");
      useCaptureStore.getState().setCustomMode(customMode);
      const { result } = renderHook(() => useCaptureWorkflow());
      let got: unknown;
      await act(async () => {
        got = await result.current.trigger();
      });
      expect(beginRegionCaptureMock).toHaveBeenCalledWith(overlayMode);
      expect(captureFullscreenMock).not.toHaveBeenCalled();
      expect(got).toBeNull();
      expect(emitErrorToastMock).not.toHaveBeenCalled();
    }
  );

  it("object mode opens the overlay when the model is ready", async () => {
    ensureObjectModelMock.mockResolvedValueOnce({
      status: "ready",
      model: { id: "ui-elements", label: "UI Elements" },
    });
    beginRegionCaptureMock.mockResolvedValueOnce(undefined);
    useCaptureStore.getState().setCaptureType("custom");
    useCaptureStore.getState().setCustomMode("object");
    const { result } = renderHook(() => useCaptureWorkflow());
    let got: unknown;
    await act(async () => {
      got = await result.current.trigger();
    });
    expect(ensureObjectModelMock).toHaveBeenCalledTimes(1);
    expect(beginRegionCaptureMock).toHaveBeenCalledWith("object");
    expect(got).toBeNull();
    expect(emitErrorToastMock).not.toHaveBeenCalled();
  });

  it("object mode surfaces a toast and opens no overlay while downloading", async () => {
    ensureObjectModelMock.mockResolvedValueOnce({
      status: "downloading",
      model: { id: "ui-elements", label: "UI Elements" },
    });
    useCaptureStore.getState().setCaptureType("custom");
    useCaptureStore.getState().setCustomMode("object");
    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(beginRegionCaptureMock).not.toHaveBeenCalled();
    expect(emitErrorToastMock).toHaveBeenCalledTimes(1);
    expect(emitErrorToastMock.mock.calls[0]?.[0]).toContain("Downloading");
  });

  it("object mode points the user at Settings when the model is missing", async () => {
    ensureObjectModelMock.mockResolvedValueOnce({
      status: "missing",
      model: { id: "ui-elements", label: "UI Elements" },
    });
    useCaptureStore.getState().setCaptureType("custom");
    useCaptureStore.getState().setCustomMode("object");
    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(beginRegionCaptureMock).not.toHaveBeenCalled();
    expect(emitErrorToastMock.mock.calls[0]?.[0]).toContain(
      "Settings → Models"
    );
  });

  it("object mode surfaces a toast when the readiness check fails", async () => {
    ensureObjectModelMock.mockRejectedValueOnce(
      new TauriCommandError({ code: "models", message: "registry unreachable" })
    );
    useCaptureStore.getState().setCaptureType("custom");
    useCaptureStore.getState().setCustomMode("object");
    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(beginRegionCaptureMock).not.toHaveBeenCalled();
    expect(emitErrorToastMock).toHaveBeenCalledWith("registry unreachable");
  });
});

describe("useCaptureWorkflow — clipboard branch", () => {
  beforeEach(() => {
    captureFullscreenMock.mockReset();
    beginRegionCaptureMock.mockReset();
    emitOverlayTogglesMock.mockReset();
    emitErrorToastMock.mockReset();
    startCountdownMock.mockReset();
    ingestClipboardMock.mockReset();
    pendingFinishedHandler = null;
    pendingCancelledHandler = null;
    useCaptureStore.setState(initialState, true);
    useCaptureStore.getState().setCaptureType("custom");
    useCaptureStore.getState().setCustomMode("clipboard");
  });

  it("ingests with the preview flag, opening no overlay and no toggle mirror", async () => {
    useCaptureStore.getState().setOption("preview", true);
    ingestClipboardMock.mockResolvedValueOnce({ kind: "image" });
    const { result } = renderHook(() => useCaptureWorkflow());
    let got: unknown;
    await act(async () => {
      got = await result.current.trigger();
    });
    expect(ingestClipboardMock).toHaveBeenCalledWith(true);
    expect(beginRegionCaptureMock).not.toHaveBeenCalled();
    expect(emitOverlayTogglesMock).not.toHaveBeenCalled();
    expect(emitErrorToastMock).not.toHaveBeenCalled();
    expect(got).toBeNull();
  });

  it("forwards preview=false when the toggle is off (text branch)", async () => {
    useCaptureStore.getState().setOption("preview", false);
    ingestClipboardMock.mockResolvedValueOnce({ kind: "text", text: "hi" });
    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(ingestClipboardMock).toHaveBeenCalledWith(false);
    expect(emitErrorToastMock).not.toHaveBeenCalled();
  });

  it("surfaces a friendly toast when the clipboard is empty", async () => {
    ingestClipboardMock.mockResolvedValueOnce({ kind: "empty" });
    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(emitErrorToastMock).toHaveBeenCalledWith(
      "Clipboard is empty — copy something first."
    );
  });

  it("skips the countdown even when the delay toggle is on", async () => {
    useCaptureStore.getState().setDelayEnabled(true);
    useCaptureStore.getState().setDelaySeconds(5);
    ingestClipboardMock.mockResolvedValueOnce({ kind: "empty" });
    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(startCountdownMock).not.toHaveBeenCalled();
    expect(ingestClipboardMock).toHaveBeenCalled();
  });

  it("emits an error toast on ingest failure", async () => {
    ingestClipboardMock.mockRejectedValueOnce(
      new TauriCommandError({
        code: "capture",
        message: "clipboard open: denied",
      })
    );
    const { result } = renderHook(() => useCaptureWorkflow());
    await act(async () => {
      await result.current.trigger();
    });
    expect(emitErrorToastMock).toHaveBeenCalledWith("clipboard open: denied");
  });
});
