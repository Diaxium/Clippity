import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const patchMock = vi.fn();
const getDefaultCapturesDirMock = vi.fn();
const openDialogMock = vi.fn();

vi.mock("@features/settings", () => ({
  useSettingsPatch: () => patchMock,
}));
vi.mock("@services/tauri/clients/settings", () => ({
  getDefaultCapturesDir: () => getDefaultCapturesDirMock(),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialogMock(...args),
}));

import { useOnboardingDraft } from "./useOnboardingDraft";
import type { Settings } from "@services/tauri/clients/settings";

const settings: Settings = {
  general: {
    capturesDir: "",
    nameTemplate: "{label} - {date} {time}",
    startOnStartup: false,
    automaticUpdates: true,
    helpImprove: true,
    onboarded: false,
  },
  appearance: {
    theme: "system",
    accent: "#FF6E4A",
    windowOpacity: 100,
    uiScale: 100,
    cornerRadius: "default",
    density: "comfortable",
    appIcon: "color",
  },
  notifications: {
    corner: "bottom-right",
    durations: {
      color: 8000,
      palette: 9000,
      clipboard: 0,
      text: 0,
      recording: 0,
      error: 6000,
    },
  },
  performance: {
    gpuAcceleration: true,
    windowEffects: true,
    reducedAnimations: false,
    captureCompression: "balanced",
  },
  capture: {
    preview: true,
    clipboard: false,
    cursor: false,
    enhance: false,
    delay: false,
    delaySeconds: 5,
    scrollDirection: "down",
    paletteCount: 6,
  },
  recording: {
    microphone: false,
    systemAudio: false,
    microphoneDevice: null,
    systemDevice: null,
    videoFps: 30,
    gifFps: 15,
    cursor: false,
    outline: true,
  },
  models: {
    autoDownload: true,
    objectModel: "ui-elements",
    confidence: 25,
  },
  shortcuts: {
    overrides: {},
    globalCapture: "Mod+Shift+2",
    globalCaptureEnabled: true,
  },
};

describe("useOnboardingDraft", () => {
  beforeEach(() => {
    patchMock.mockReset();
    getDefaultCapturesDirMock.mockReset();
    openDialogMock.mockReset();
    getDefaultCapturesDirMock.mockResolvedValue(
      "C:/users/sample/Pictures/Clippity"
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts on step 0 with no error and no saving", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useOnboardingDraft({ settings, onComplete })
    );
    expect(result.current.step).toBe(0);
    expect(result.current.error).toBeNull();
    expect(result.current.saving).toBe(false);
    await waitFor(() =>
      expect(result.current.defaultHint).toBe(
        "C:/users/sample/Pictures/Clippity"
      )
    );
  });

  it("setTheme calls patch with appearance.theme replaced", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useOnboardingDraft({ settings, onComplete })
    );
    await waitFor(() => expect(result.current.defaultHint).not.toBe(""));
    act(() => result.current.setTheme("dark"));
    expect(patchMock).toHaveBeenCalledWith({
      appearance: { ...settings.appearance, theme: "dark" },
    });
  });

  it("setAccent calls patch with appearance.accent replaced", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useOnboardingDraft({ settings, onComplete })
    );
    await waitFor(() => expect(result.current.defaultHint).not.toBe(""));
    act(() => result.current.setAccent("#123456"));
    expect(patchMock).toHaveBeenCalledWith({
      appearance: { ...settings.appearance, accent: "#123456" },
    });
  });

  it("next advances through steps and finalizes on step 2", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useOnboardingDraft({ settings, onComplete })
    );
    await waitFor(() => expect(result.current.defaultHint).not.toBe(""));
    act(() => result.current.next());
    expect(result.current.step).toBe(1);
    act(() => result.current.next());
    expect(result.current.step).toBe(2);
    act(() => result.current.next());
    expect(patchMock).toHaveBeenLastCalledWith({
      general: {
        ...settings.general,
        capturesDir: "",
        onboarded: true,
      },
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("back is a no-op on step 0", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useOnboardingDraft({ settings, onComplete })
    );
    await waitFor(() => expect(result.current.defaultHint).not.toBe(""));
    act(() => result.current.back());
    expect(result.current.step).toBe(0);
  });

  it("browse propagates the picker path into the local draft", async () => {
    openDialogMock.mockResolvedValueOnce("D:/snaps");
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useOnboardingDraft({ settings, onComplete })
    );
    await waitFor(() => expect(result.current.defaultHint).not.toBe(""));
    await act(async () => {
      await result.current.browse();
    });
    expect(result.current.capturesDir).toBe("D:/snaps");
  });

  it("resetCapturesDir restores the empty/default state", async () => {
    const onComplete = vi.fn();
    const { result } = renderHook(() =>
      useOnboardingDraft({ settings, onComplete })
    );
    await waitFor(() => expect(result.current.defaultHint).not.toBe(""));
    act(() => result.current.setCapturesDir("E:/elsewhere"));
    expect(result.current.capturesDir).toBe("E:/elsewhere");
    act(() => result.current.resetCapturesDir());
    expect(result.current.capturesDir).toBe("");
  });
});
