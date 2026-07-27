/**
 * Settings design-review harness (dev only).
 *
 * Seeds the settings store with a representative snapshot and mounts the
 * real `SettingsLayout` so the panels — in particular the new Capture
 * panel — can be reviewed in a plain browser via the dev server, no
 * Tauri runtime required. `useSettings` still fires its `getSettings`
 * IPC on mount, but that rejects harmlessly outside Tauri and never
 * clears the pre-seeded snapshot.
 *
 * Referenced by `settings-smoke.html`. Not part of the production bundle.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SettingsLayout, useSettingsStore } from "@features/settings";
import { useCapabilitiesStore } from "@state/capabilitiesStore";
import { UNMANAGED_PROFILE, type Settings } from "@clippity/shared";

import "@styles/theme.css";
import "@styles/globals.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute(
  "data-theme",
  params.get("theme") === "light" ? "light" : "dark"
);
document.documentElement.setAttribute("data-effects", "flat");

const snapshot: Settings = {
  general: {
    capturesDir: "",
    nameTemplate: "",
    startOnStartup: false,
    automaticUpdates: true,
    helpImprove: true,
    onboarded: true,
  },
  appearance: {
    theme: "dark",
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
    delay: true,
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

useSettingsStore.getState().setSettings(snapshot);

// `?declined=1` seeds the profile of an install whose optional components
// were unchecked in the installer, so the capability-gated states (Shortcuts'
// missing global hotkey, General's disabled startup row) are reviewable in a
// plain browser. Without it the harness shows the everything-available
// profile, which is what an unmanaged build resolves to anyway.
useCapabilitiesStore.getState().setProfile(
  params.get("declined") === "1"
    ? {
        capabilities: {
          ...UNMANAGED_PROFILE.capabilities,
          globalHotkeys: false,
          textRecognition: false,
          gifRecording: false,
          startAtLogin: false,
          automaticUpdates: false,
          unmanaged: false,
        },
        source: "installer",
      }
    : UNMANAGED_PROFILE
);

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <StrictMode>
    <div style={{ height: "100vh", width: "100vw" }}>
      <SettingsLayout />
    </div>
  </StrictMode>
);
