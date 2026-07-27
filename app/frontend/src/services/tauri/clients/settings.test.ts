import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const onMock = vi.fn();

vi.mock("@services/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  on: (...args: unknown[]) => onMock(...args),
  EVENT_NAMES: {
    settingsChanged: "clippity://settings/changed",
  },
}));

import {
  getSettings,
  onSettingsChanged,
  updateSettings,
  type Settings,
  type SettingsPatch,
} from "./settings";

const sample: Settings = {
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

describe("getSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("invokes settings_get with no args", async () => {
    invokeMock.mockResolvedValueOnce(sample);
    const out = await getSettings();
    expect(invokeMock).toHaveBeenCalledWith("settings_get");
    expect(out).toEqual(sample);
  });

  it("propagates IPC errors", async () => {
    const boom = new Error("settings.json corrupt");
    invokeMock.mockRejectedValueOnce(boom);
    await expect(getSettings()).rejects.toBe(boom);
  });
});

describe("updateSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("wraps the patch in { patch } and invokes settings_update", async () => {
    invokeMock.mockResolvedValueOnce(sample);
    const patch: SettingsPatch = {
      appearance: { ...sample.appearance, theme: "dark" },
    };
    const out = await updateSettings(patch);
    expect(invokeMock).toHaveBeenCalledWith("settings_update", { patch });
    expect(out).toEqual(sample);
  });

  it("supports partial patches (one section)", async () => {
    invokeMock.mockResolvedValueOnce(sample);
    const patch: SettingsPatch = {
      general: { ...sample.general, capturesDir: "/x" },
    };
    await updateSettings(patch);
    expect(invokeMock).toHaveBeenCalledWith("settings_update", { patch });
  });
});

describe("onSettingsChanged", () => {
  beforeEach(() => {
    onMock.mockReset();
  });

  it("subscribes to clippity://settings/changed", () => {
    onMock.mockReturnValueOnce(() => {});
    const handler = vi.fn();
    onSettingsChanged(handler);
    expect(onMock).toHaveBeenCalled();
    const [eventName, fn] = onMock.mock.calls[0]!;
    expect(eventName).toBe("clippity://settings/changed");
    // The wrapped handler should forward the payload directly.
    fn(sample);
    expect(handler).toHaveBeenCalledWith(sample);
  });

  it("returns the unsubscribe function from `on`", () => {
    const unsub = vi.fn();
    onMock.mockReturnValueOnce(unsub);
    const returned = onSettingsChanged(() => {});
    returned();
    expect(unsub).toHaveBeenCalled();
  });
});
