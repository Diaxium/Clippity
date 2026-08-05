import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BACKDROP_TUNING_SET } from "../lib/backdrop";

const updateSettingsMock = vi.fn();
const emitErrorToastMock = vi.fn();

vi.mock("@services/tauri/clients/settings", () => ({
  updateSettings: (patch: unknown) => updateSettingsMock(patch),
}));
vi.mock("@services/tauri/clients/toast", () => ({
  emitErrorToast: (msg: string) => emitErrorToastMock(msg),
}));

import { useSettingsStore } from "../state/settingsStore";
import { useSettingsPatch } from "./useSettingsPatch";
import { DEFAULT_DEVELOPER_SETTINGS } from "@clippity/shared";

import type { Settings } from "../types";

const initial: Settings = {
  general: {
    capturesDir: "",
    nameTemplate: "{label} - {date} {time}",
    startOnStartup: false,
    automaticUpdates: true,
    helpImprove: true,
    onboarded: true,
  },
  appearance: {
    theme: "system",
    accent: "#FF6E4A",
    windowOpacity: 100,
    windowBackdrop: "mica",
    backdropTuning: DEFAULT_BACKDROP_TUNING_SET,
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
    microphoneGainPct: 100,
    systemGainPct: 100,
    videoFps: 30,
    gifFps: 15,
    maxHeight: 0,
    encoding: {},
    sources: [],
    cursor: false,
    outline: true,
    clipboard: false,
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
  developer: DEFAULT_DEVELOPER_SETTINGS,
};

describe("useSettingsPatch", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: initial });
    updateSettingsMock.mockReset();
    emitErrorToastMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("applies the patch optimistically and calls updateSettings", async () => {
    updateSettingsMock.mockResolvedValueOnce({
      ...initial,
      appearance: { ...initial.appearance, theme: "dark" },
    });
    const { result } = renderHook(() => useSettingsPatch());
    act(() =>
      result.current({
        appearance: { ...initial.appearance, theme: "dark" },
      })
    );
    // Optimistic mirror lands immediately.
    expect(useSettingsStore.getState().settings?.appearance.theme).toBe("dark");
    // The server response is adopted once it resolves.
    await waitFor(() =>
      expect(updateSettingsMock).toHaveBeenCalledWith({
        appearance: { ...initial.appearance, theme: "dark" },
      })
    );
  });

  it("ignores stale server responses when a newer patch is in flight", async () => {
    let resolveFirst!: (v: unknown) => void;
    updateSettingsMock.mockImplementationOnce(
      () => new Promise((r) => (resolveFirst = r))
    );
    updateSettingsMock.mockResolvedValueOnce({
      ...initial,
      appearance: { ...initial.appearance, theme: "dark" },
    });
    const { result } = renderHook(() => useSettingsPatch());
    // First patch: theme → light (server takes its time).
    act(() =>
      result.current({
        appearance: { ...initial.appearance, theme: "light" },
      })
    );
    // Second patch: theme → dark (server responds promptly).
    act(() =>
      result.current({
        appearance: { ...initial.appearance, theme: "dark" },
      })
    );
    // Now resolve the first (stale) response.
    resolveFirst({
      ...initial,
      appearance: { ...initial.appearance, theme: "light" },
    });
    // Wait a tick to allow microtasks to flush.
    await waitFor(() =>
      expect(useSettingsStore.getState().settings?.appearance.theme).toBe(
        "dark"
      )
    );
  });

  it("emits an error toast when updateSettings rejects", async () => {
    updateSettingsMock.mockRejectedValueOnce(new Error("invalid accent hex"));
    const { result } = renderHook(() => useSettingsPatch());
    act(() =>
      result.current({
        appearance: { ...initial.appearance, accent: "bogus" },
      })
    );
    await waitFor(() =>
      expect(emitErrorToastMock).toHaveBeenCalledWith(
        expect.stringContaining("invalid accent hex")
      )
    );
  });

  it("no-ops when settings are not yet hydrated", () => {
    useSettingsStore.setState({ settings: null });
    const { result } = renderHook(() => useSettingsPatch());
    act(() =>
      result.current({
        appearance: { ...initial.appearance, theme: "dark" },
      })
    );
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });
});
