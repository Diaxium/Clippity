/**
 * Developer + diagnostics IPC client.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live here rather than in the feature, so Settings →
 * Advanced, the performance overlay, and the log forwarder all reach the
 * backend through one place.
 *
 * Rust side: `app::commands::developer_*` → `services::diagnostics_service`.
 */

import { invoke } from "@services/tauri";
import type {
  BundleOptions,
  BundleResult,
  CacheTarget,
  FolderTarget,
  LogLine,
  RecorderDiagnostics,
  RuntimeStatus,
  SystemInfo,
} from "@clippity/shared";
import { setLogForwarder } from "@shared/lib/logger";
import type { LogLevel } from "@clippity/shared";

export type {
  BundleOptions,
  BundleResult,
  CacheTarget,
  DiagnosticPaths,
  FolderTarget,
  LogLine,
  MonitorDiagnostics,
  RecorderDiagnostics,
  RuntimeStatus,
  ShortcutDiagnostics,
  SystemInfo,
  WindowDiagnostics,
} from "@clippity/shared";

/**
 * Facts about the running process that override what settings say. The
 * settings page reads these so it can describe what is actually in
 * force rather than showing controls that quietly do nothing.
 */
export interface RuntimeFlags {
  /** GPU acceleration, window effects and the global hotkey are off
   *  this session regardless of the persisted preferences. */
  safeMode: boolean;
  /** `CLIPPITY_LOG` / `RUST_LOG` is driving the backend filter, so the
   *  backend log-level control is inert for this process. */
  logLevelPinned: boolean;
  /** Whether this build can open the WebView inspector. */
  devtoolsAvailable: boolean;
}

// ---------- Inspection ----------

/** Versions, paths, monitors, models, log size — the system card. */
export function getSystemInfo(): Promise<SystemInfo> {
  return invoke<SystemInfo>("developer_system_info");
}

/** Windows, capture shielding, the global hotkey's real registration,
 *  index + cache sizes. */
export function getRuntimeStatus(): Promise<RuntimeStatus> {
  return invoke<RuntimeStatus>("developer_runtime_status");
}

/** Safe mode / pinned log level / devtools availability. */
export function getRuntimeFlags(): Promise<RuntimeFlags> {
  return invoke<RuntimeFlags>("developer_runtime_flags");
}

/** Statistics from the last recording session, or null when nothing has
 *  been recorded since launch. */
export function getRecorderDiagnostics(): Promise<RecorderDiagnostics | null> {
  return invoke<RecorderDiagnostics | null>("developer_recorder_diagnostics");
}

// ---------- Developer tools ----------

/**
 * Open or close the WebView inspector for the calling window.
 *
 * Per-window by design: each Tauri window is its own webview, so the
 * tools a user wants are the ones for the surface they are looking at.
 */
export function setDevtoolsOpen(open: boolean): Promise<void> {
  return invoke<void, { open: boolean }>("developer_open_devtools", { open });
}

// ---------- Logs ----------

/** The last `limit` lines of the log, oldest first. */
export function tailLog(limit: number): Promise<LogLine[]> {
  return invoke<LogLine[], { limit: number }>("developer_log_tail", { limit });
}

/** Delete every rotated log file and empty the live one. Returns bytes
 *  freed. */
export function clearLogs(): Promise<number> {
  return invoke<number>("developer_clear_logs");
}

/**
 * Mirror one frontend record into the backend log file.
 *
 * Fire-and-forget: this is called from inside the logger, so a rejected
 * promise here would be logged, which would call this again. See
 * [`installLogForwarding`].
 */
function forwardLog(record: {
  level: string;
  module: string;
  message: string;
  context?: string | null;
}): void {
  void invoke<void, typeof record>("developer_log", record).catch(() => {
    /* swallowed deliberately — see the doc comment */
  });
}

/**
 * Route the frontend logger into the backend's log file, so a bug that
 * crosses the IPC boundary reads as one timeline instead of two.
 *
 * Two guards, both load-bearing:
 *
 * - **Re-entrancy.** `forwardLog` calls `invoke`, and `invoke` logs when
 *   a command fails. Without the flag, one failing forward would log,
 *   which would forward, which would fail…
 * - **The `ipc` module is not forwarded.** It is the module that
 *   *reports* IPC failures, so forwarding it would mean an unreachable
 *   backend produces a record whose only route is the unreachable
 *   backend. Those lines stay in the console, where they can be read.
 */
export function installLogForwarding(): void {
  let inside = false;
  setLogForwarder(({ level, module, message, context }) => {
    if (inside || module === "ipc") return;
    inside = true;
    try {
      forwardLog({
        level,
        module,
        message,
        context: context === undefined ? null : safeJson(context),
      });
    } finally {
      inside = false;
    }
  });
}

/** Stop mirroring records into the backend log. */
export function uninstallLogForwarding(): void {
  setLogForwarder(null);
}

/** Serialize an already-redacted context object for the log file.
 *  Never throws — a context that can't be encoded is worth less than
 *  the message it belongs to. */
function safeJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    // A log line, not a payload dump: the interesting part of a context
    // object is at the front.
    return json ? json.slice(0, 2_000) : null;
  } catch {
    return null;
  }
}

/** Level names, ordered least to most severe — the log-level pickers
 *  render this. `off` is included: it is a legal choice for both. */
export const LOG_LEVELS: readonly LogLevel[] = [
  "off",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

// ---------- Folders, caches, bundles ----------

/** Open one of the app's own folders in the OS file manager. Returns
 *  the path opened. */
export function openFolder(target: FolderTarget): Promise<string> {
  return invoke<string, { target: FolderTarget }>("developer_open_folder", {
    target,
  });
}

/** Clear one cache. Returns bytes freed. */
export function clearCache(target: CacheTarget): Promise<number> {
  return invoke<number, { target: CacheTarget }>("developer_clear_cache", {
    target,
  });
}

/** Write a diagnostics bundle and return where it landed. */
export function exportDiagnosticsBundle(
  options: BundleOptions
): Promise<BundleResult> {
  return invoke<BundleResult, { options: BundleOptions }>(
    "developer_export_bundle",
    { options }
  );
}

/**
 * Arm safe mode and restart.
 *
 * The process is replaced, so the returned promise never meaningfully
 * resolves — don't chain work after it.
 */
export function restartInSafeMode(): Promise<void> {
  return invoke<void>("developer_restart_safe_mode");
}
