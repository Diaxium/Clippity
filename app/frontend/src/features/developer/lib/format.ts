/**
 * Formatting for the diagnostics surfaces, plus the plain-text summary
 * behind "Copy system information".
 *
 * Pure and unit-tested: the copied summary is what ends up pasted into
 * a bug report, so "did it include the monitor layout?" is a question
 * worth having an answer to that doesn't involve launching the app.
 */

import type {
  MonitorDiagnostics,
  RecorderDiagnostics,
  RuntimeStatus,
  SystemInfo,
} from "@services/tauri/clients/developer";

/** `1.4 KB`, `824 KB`, `4.2 MB` — the unit a reader thinks in. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / 1024 ** exponent;
  // Whole numbers below a kilobyte; one decimal above, which is as much
  // precision as a size readout can honestly claim.
  const digits = exponent === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

/** `42 ms`, `1.20 s` — durations as measured, not rounded to nothing. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** `3m 04s`, `1h 12m` — for uptime and recording lengths. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** `2560×1440 @150% · 165 Hz` — one monitor, as a person describes it. */
export function formatMonitor(monitor: MonitorDiagnostics): string {
  const scale = `${Math.round(monitor.scale * 100)}%`;
  const refresh =
    monitor.refreshHz > 0 ? ` · ${Math.round(monitor.refreshHz)} Hz` : "";
  const hdr = monitor.hdr
    ? ` · HDR${
        monitor.sdrWhiteNits
          ? ` (SDR white ${Math.round(monitor.sdrWhiteNits)} nits)`
          : ""
      }`
    : "";
  const primary = monitor.primary ? " · primary" : "";
  return `${monitor.width}×${monitor.height} @${scale}${refresh} at (${monitor.x}, ${monitor.y})${primary}${hdr}`;
}

/**
 * The plain-text block "Copy system information" puts on the clipboard.
 *
 * Markdown-ish rather than JSON: it is pasted into an issue, a chat, or
 * an email, and none of those render a JSON blob usefully. Paths are
 * included as-is — this is the *unredacted* summary, which is why the
 * button that produces it says so and the exported bundle (the thing
 * meant to be sent onward) redacts by default.
 */
export function formatSystemSummary(
  info: SystemInfo,
  status?: RuntimeStatus | null
): string {
  const lines: string[] = [
    "Clippity diagnostics",
    `- Version: ${info.appVersion} (${info.buildProfile}${
      info.portable ? ", portable" : ""
    }${info.safeMode ? ", SAFE MODE" : ""})`,
    `- OS: ${info.osVersion} (${info.os}/${info.arch}, ${info.cpuCount} cores)`,
    `- WebView: ${info.webviewVersion ?? "unknown"}`,
    `- Uptime: ${formatDuration(info.uptimeMs)}`,
    "",
    "Paths",
    `- Data: ${info.paths.data}`,
    `- Captures: ${info.paths.captures}`,
    `- Cache: ${info.paths.cache}`,
    `- Models: ${info.paths.models}`,
    `- Logs: ${info.paths.logs}${
      info.logBytes > 0 ? ` (${formatBytes(info.logBytes)})` : ""
    }`,
    "",
    "Displays",
    ...(info.monitors.length > 0
      ? info.monitors.map((m) => `- ${m.name}: ${formatMonitor(m)}`)
      : ["- none reported"]),
    "",
    "Models installed",
    ...(info.installedModels.length > 0
      ? info.installedModels.map((m) => `- ${m}`)
      : ["- none"]),
  ];

  if (status) {
    lines.push(
      "",
      "Runtime",
      `- Capture shield: ${status.captureShielded ? "on" : "off"}`,
      `- Global capture hotkey: ${
        status.globalCapture.registered
          ? `${status.globalCapture.combo} (registered)`
          : `${status.globalCapture.combo || "none"} — ${
              status.globalCapture.detail ?? "not registered"
            }`
      }`,
      `- Library index: ${formatBytes(status.libraryDbBytes)}`,
      `- Cache on disk: ${formatBytes(status.cacheBytes)}`,
      `- Windows: ${status.windows
        .map((w) => `${w.label}${w.visible ? "" : " (hidden)"}`)
        .join(", ")}`
    );
  }

  return lines.join("\n");
}

/** `mp4 1920×1080 @60 fps` — what a recording session was asked for. */
export function formatRecorderTarget(d: RecorderDiagnostics): string {
  return `${d.format.toUpperCase()} ${d.width}×${d.height} @${d.targetFps} fps`;
}

/**
 * Pure: dropped frames as a percentage of everything the source
 * produced — mirrors `RecorderDiagnostics::drop_rate_pct` on the Rust
 * side, so the HUD and the settings page can't disagree.
 */
export function dropRatePct(d: RecorderDiagnostics): number {
  const produced = d.frames + d.dropped;
  return produced === 0 ? 0 : (d.dropped / produced) * 100;
}

/**
 * Average bitrate in kbit/s, or null for a session with no duration —
 * a discard, or a failure before the first frame — where the number
 * would be a division dressed up as data.
 */
export function avgBitrateKbps(d: RecorderDiagnostics): number | null {
  if (d.durationMs === 0 || d.bytes === 0) return null;
  return Math.round((d.bytes * 8) / d.durationMs);
}
