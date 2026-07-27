import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

import { act, renderHook } from "@testing-library/react";

// Mock every IPC client the hook touches BEFORE importing it.
vi.mock("@services/tauri/clients/capture", () => ({
  captureFullscreen: vi.fn(() => Promise.resolve()),
}));
vi.mock("@services/tauri/clients/countdown", () => ({
  startCountdown: vi.fn(() => Promise.resolve()),
  onCountdownFinished: vi.fn(() => () => {}),
  onCountdownCancelled: vi.fn(() => () => {}),
}));
vi.mock("@services/tauri/clients/overlay", () => ({
  beginRegionCapture: vi.fn(() => Promise.resolve()),
  emitOverlayToggles: vi.fn(() => Promise.resolve()),
}));
vi.mock("@services/tauri/clients/dashboard", () => ({
  openDashboard: vi.fn(() => Promise.resolve()),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  showCaptureWindow: vi.fn(() => Promise.resolve()),
}));
vi.mock("@services/tauri/clients/tray", () => ({
  hideTrayPanel: vi.fn(() => Promise.resolve()),
  onTrayOpened: vi.fn(() => () => {}),
  quitApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@services/tauri/clients/presets", () => ({
  runPreset: vi.fn(() => Promise.resolve()),
}));

import { captureFullscreen } from "@services/tauri/clients/capture";
import {
  onCountdownCancelled,
  onCountdownFinished,
  startCountdown,
} from "@services/tauri/clients/countdown";
import { beginRegionCapture } from "@services/tauri/clients/overlay";
import { hideTrayPanel } from "@services/tauri/clients/tray";
import { useTrayPanel } from "./useTrayPanel";

describe("useTrayPanel", () => {
  beforeEach(() => {
    // Default: the countdown listeners never fire (so the delay gate only
    // resolves in the tests that opt into firing an outcome below). Reset
    // here because `clearAllMocks` clears call history, not implementations.
    (onCountdownFinished as Mock).mockImplementation(() => () => {});
    (onCountdownCancelled as Mock).mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("hides the panel then captures fullscreen, with no countdown when Timed is off", async () => {
    const { result } = renderHook(() => useTrayPanel());
    await act(async () => {
      await result.current.actions.fullscreen();
    });
    expect(hideTrayPanel).toHaveBeenCalled();
    expect(startCountdown).not.toHaveBeenCalled();
    expect(captureFullscreen).toHaveBeenCalled();
  });

  it("runs the countdown before capturing when Timed is enabled", async () => {
    // Resolve the delay gate by firing `finished` the moment it subscribes.
    (onCountdownFinished as Mock).mockImplementation((cb: () => void) => {
      cb();
      return () => {};
    });
    const { result } = renderHook(() => useTrayPanel());
    act(() => {
      result.current.setToggle("timed", true);
    });
    await act(async () => {
      await result.current.actions.fullscreen();
    });
    expect(startCountdown).toHaveBeenCalledWith(3);
    expect(captureFullscreen).toHaveBeenCalled();
  });

  it("skips the shot when the timed countdown is cancelled", async () => {
    (onCountdownCancelled as Mock).mockImplementation((cb: () => void) => {
      cb();
      return () => {};
    });
    const { result } = renderHook(() => useTrayPanel());
    act(() => {
      result.current.setToggle("timed", true);
    });
    await act(async () => {
      await result.current.actions.fullscreen();
    });
    expect(startCountdown).toHaveBeenCalledWith(3);
    expect(captureFullscreen).not.toHaveBeenCalled();
  });

  it("opens the overlay for a region capture", async () => {
    const { result } = renderHook(() => useTrayPanel());
    await act(async () => {
      await result.current.actions.region();
    });
    expect(beginRegionCapture).toHaveBeenCalledWith("region");
  });

  it("opens the overlay for a window capture", async () => {
    const { result } = renderHook(() => useTrayPanel());
    await act(async () => {
      await result.current.actions.windowCapture();
    });
    expect(beginRegionCapture).toHaveBeenCalledWith("window");
  });
});
