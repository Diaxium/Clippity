import { describe, expect, it } from "vitest";

import type {
  MonitorDiagnostics,
  RecorderDiagnostics,
  RuntimeStatus,
  SystemInfo,
} from "@services/tauri/clients/developer";

import {
  avgBitrateKbps,
  dropRatePct,
  formatBytes,
  formatDuration,
  formatMonitor,
  formatMs,
  formatRecorderTarget,
  formatSystemSummary,
} from "./format";

const MONITOR: MonitorDiagnostics = {
  id: 1,
  name: "\\\\.\\DISPLAY1",
  x: -1920,
  y: 0,
  width: 2560,
  height: 1440,
  scale: 1.5,
  refreshHz: 164.9,
  primary: true,
  hdr: false,
  sdrWhiteNits: null,
};

const INFO: SystemInfo = {
  appVersion: "0.1.0",
  buildProfile: "release",
  safeMode: false,
  portable: false,
  os: "windows",
  osVersion: "Windows 11 Pro 24H2 (build 26100.1)",
  arch: "x86_64",
  webviewVersion: "132.0.0",
  cpuCount: 16,
  paths: {
    data: "C:\\Data",
    cache: "C:\\Cache",
    captures: "C:\\Captures",
    models: "C:\\Models",
    logs: "C:\\Logs",
    executable: "C:\\App\\clippity.exe",
    settingsFile: "C:\\Data\\settings.json",
  },
  monitors: [MONITOR],
  installedModels: ["ui-elements (onnx-v3)"],
  logFile: "C:\\Logs\\clippity.log",
  logBytes: 2_500_000,
  uptimeMs: 3_723_000,
};

const RECORDING: RecorderDiagnostics = {
  format: "mp4",
  width: 1920,
  height: 1080,
  targetFps: 60,
  frames: 900,
  dropped: 100,
  durationMs: 15_000,
  bytes: 3_000_000,
  hadAudio: true,
  preferredHardware: true,
  outcome: "committed",
};

describe("formatBytes", () => {
  it("uses the unit a reader thinks in", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1_536)).toBe("1.5 KB");
    expect(formatBytes(4_200_000)).toBe("4.0 MB");
  });

  it("drops the decimal once the number is big enough not to need it", () => {
    expect(formatBytes(150 * 1024)).toBe("150 KB");
  });

  it("never claims a negative or nonsense size", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("formatMs", () => {
  it("keeps sub-millisecond precision instead of rounding it away", () => {
    expect(formatMs(0.42)).toBe("0.42 ms");
    expect(formatMs(42.4)).toBe("42 ms");
    expect(formatMs(1_200)).toBe("1.20 s");
  });

  it("shows an em dash rather than a fabricated zero", () => {
    expect(formatMs(Number.NaN)).toBe("—");
    expect(formatMs(-5)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("scales to the largest useful unit", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_723_000)).toBe("1h 02m");
  });
});

describe("formatMonitor", () => {
  it("states the geometry that explains a mis-cropped capture", () => {
    const text = formatMonitor(MONITOR);
    expect(text).toContain("2560×1440");
    expect(text).toContain("@150%");
    expect(text).toContain("165 Hz");
    // The negative origin is the case that breaks naive capture math,
    // so it has to be visible.
    expect(text).toContain("(-1920, 0)");
    expect(text).toContain("primary");
  });

  it("names the HDR white level when the display is in HDR", () => {
    const text = formatMonitor({ ...MONITOR, hdr: true, sdrWhiteNits: 240 });
    expect(text).toContain("HDR");
    expect(text).toContain("240 nits");
  });
});

describe("formatSystemSummary", () => {
  it("includes what a bug report needs", () => {
    const text = formatSystemSummary(INFO);
    expect(text).toContain("0.1.0 (release)");
    expect(text).toContain("Windows 11 Pro 24H2");
    expect(text).toContain("132.0.0");
    expect(text).toContain("C:\\Captures");
    expect(text).toContain("2560×1440");
    expect(text).toContain("ui-elements (onnx-v3)");
    expect(text).toContain("1h 02m");
  });

  it("flags safe mode and a portable install", () => {
    const text = formatSystemSummary({
      ...INFO,
      safeMode: true,
      portable: true,
    });
    expect(text).toContain("portable");
    expect(text).toContain("SAFE MODE");
  });

  it("says so when the global hotkey is not registered", () => {
    const status: RuntimeStatus = {
      windows: [
        {
          label: "main",
          visible: true,
          focused: true,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
      captureShielded: true,
      globalCapture: {
        combo: "Mod+Shift+2",
        registered: false,
        detail: "the OS refused it — another application may already own it",
      },
      globalHotkeysInstalled: true,
      libraryDb: "C:\\Data\\library.db",
      libraryDbBytes: 1024,
      cacheBytes: 2048,
      monitors: [MONITOR],
    };
    const text = formatSystemSummary(INFO, status);
    expect(text).toContain("another application may already own it");
    expect(text).toContain("main");
  });

  it("reports no displays rather than an empty section", () => {
    const text = formatSystemSummary({
      ...INFO,
      monitors: [],
      installedModels: [],
    });
    expect(text).toContain("none reported");
    expect(text).toContain("- none");
  });
});

describe("recording maths", () => {
  it("measures the drop rate against everything the source produced", () => {
    expect(dropRatePct(RECORDING)).toBeCloseTo(10, 5);
    expect(dropRatePct({ ...RECORDING, frames: 0, dropped: 0 })).toBe(0);
  });

  it("reports no bitrate for a session with no duration", () => {
    // Better no number than a division dressed up as data.
    expect(avgBitrateKbps({ ...RECORDING, durationMs: 0 })).toBeNull();
    expect(avgBitrateKbps({ ...RECORDING, bytes: 0 })).toBeNull();
  });

  it("computes the average bitrate in kbit/s", () => {
    // 1 MB over 8 s = 1 Mbit/s.
    expect(
      avgBitrateKbps({ ...RECORDING, bytes: 1_000_000, durationMs: 8_000 })
    ).toBe(1_000);
  });

  it("names what the session was asked to produce", () => {
    expect(formatRecorderTarget(RECORDING)).toBe("MP4 1920×1080 @60 fps");
  });
});
