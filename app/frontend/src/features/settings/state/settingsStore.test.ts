import { beforeEach, describe, expect, it } from "vitest";

import { useSettingsStore } from "./settingsStore";
import type { Settings } from "../types";

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
};

describe("useSettingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: null });
  });

  it("starts unhydrated (settings === null)", () => {
    expect(useSettingsStore.getState().settings).toBeNull();
  });

  it("setSettings replaces the snapshot atomically", () => {
    useSettingsStore.getState().setSettings(sample);
    expect(useSettingsStore.getState().settings).toEqual(sample);
  });

  it("setSettings is idempotent for the same value (reference replace OK)", () => {
    useSettingsStore.getState().setSettings(sample);
    useSettingsStore.getState().setSettings(sample);
    expect(useSettingsStore.getState().settings).toEqual(sample);
  });
});
