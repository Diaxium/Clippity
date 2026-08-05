/**
 * Developer + diagnostics wire-format contracts — mirror Rust
 * `domain::developer`.
 *
 * These back Settings → Advanced: the system-information card, the log
 * viewer, the runtime-status tables, the diagnostics-bundle export, and
 * the recorder's post-session statistics. The *preferences* that decide
 * what is shown live on `DeveloperSettings` in `./settings`.
 */

/** What an exported diagnostics bundle may contain. Every field
 *  defaults to the private answer — an unconfigured bundle is the
 *  redacted one. Mirrors Rust `domain::developer::BundleOptions`. */
export interface BundleOptions {
  /** Replace the account name + home directory in every included file. */
  redactPaths: boolean;
  /** Replace capture file names with `<capture>.<ext>` — a capture is
   *  routinely named after the window it came from. */
  redactCaptureNames: boolean;
  /** Copy the retained log files into the bundle. */
  includeLogs: boolean;
  /** Include the persisted settings.json (itself redacted). */
  includeSettings: boolean;
}

/** Where an exported bundle landed, and what went into it. */
export interface BundleResult {
  /** Absolute path of the bundle folder. */
  path: string;
  /** File names written inside it, in write order. */
  files: string[];
  bytes: number;
  redacted: boolean;
}

/** One monitor as the capture pipeline sees it — the numbers that
 *  explain a mis-cropped multi-monitor or mixed-DPI capture. */
export interface MonitorDiagnostics {
  id: number;
  name: string;
  /** Physical position on the virtual desktop; negative left of / above
   *  the primary, which is the case that breaks naive capture math. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** DPI scale as a factor (1.5 = 150 %). */
  scale: number;
  refreshHz: number;
  primary: boolean;
  /** Whether Windows reports this output presenting in HDR. */
  hdr: boolean;
  /** SDR white level in nits when known — what an HDR tone-map anchors to. */
  sdrWhiteNits: number | null;
}

/** The app's own directories, as resolved for this process. */
export interface DiagnosticPaths {
  data: string;
  cache: string;
  captures: string;
  models: string;
  logs: string;
  executable: string;
  settingsFile: string;
}

/** Everything "Copy system information" puts on the clipboard, and the
 *  first file in an exported bundle. */
export interface SystemInfo {
  appVersion: string;
  /** `debug` or `release`. */
  buildProfile: string;
  /** True when this process was started by "Restart in safe mode". */
  safeMode: boolean;
  /** True when running from a portable folder rather than an install. */
  portable: boolean;
  os: string;
  osVersion: string;
  arch: string;
  webviewVersion: string | null;
  cpuCount: number;
  paths: DiagnosticPaths;
  monitors: MonitorDiagnostics[];
  installedModels: string[];
  /** Live log file, when disk logging is on. */
  logFile: string | null;
  /** Total bytes across every retained log file. */
  logBytes: number;
  uptimeMs: number;
}

/** State of one registered global accelerator. */
export interface ShortcutDiagnostics {
  /** What the setting asked for, in `Mod+Shift+Key` notation. */
  combo: string;
  registered: boolean;
  /** Why not, when it isn't (unparseable, reserved, taken). */
  detail: string | null;
}

/** One window the app owns, and whether it is currently on screen. */
export interface WindowDiagnostics {
  label: string;
  visible: boolean;
  focused: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Live runtime state — the answer to "why is nothing happening?". */
export interface RuntimeStatus {
  windows: WindowDiagnostics[];
  /** Whether every Clippity window is excluded from screen capture. */
  captureShielded: boolean;
  globalCapture: ShortcutDiagnostics;
  /** Whether the installer's capture integration is present at all. */
  globalHotkeysInstalled: boolean;
  libraryDb: string;
  libraryDbBytes: number;
  cacheBytes: number;
  monitors: MonitorDiagnostics[];
}

/** What the last recording session actually did — kept after the
 *  session ends, unlike the live `RecorderStatus`. */
export interface RecorderDiagnostics {
  format: string;
  width: number;
  height: number;
  targetFps: number;
  frames: number;
  dropped: number;
  durationMs: number;
  bytes: number;
  hadAudio: boolean;
  /** Whether the session asked for a hardware encoder. */
  preferredHardware: boolean;
  /** `committed` / `discarded` / `failed`. */
  outcome: string;
}

/** A cache a developer may clear. The enum exists so the command
 *  surface can't be handed an arbitrary path to delete. */
export type CacheTarget = "thumbnails" | "webview" | "models" | "temp" | "logs";

/** A folder the developer page can open in the OS file manager. An
 *  enum, like `CacheTarget`, so "open a folder" can never become "open
 *  whatever path the webview asked for". */
export type FolderTarget =
  "data" | "logs" | "captures" | "cache" | "models" | "bundles" | "install";

/** One line of the log file, as the viewer renders it. */
export interface LogLine {
  /** Monotonic index within the returned window — a stable React key. */
  seq: number;
  /** Timestamp as written, or empty for a continuation line. */
  timestamp: string;
  /** Lower-case level, or empty when the line carries none (a panic
   *  backtrace, say — which is exactly what must not be dropped). */
  level: string;
  message: string;
}

/** A log record forwarded from the frontend so both halves of the app
 *  share one timeline in the file. Mirrors the `developer_log` command. */
export interface FrontendLogRecord {
  /** `error` | `warn` | `info` | `debug` | `trace`. */
  level: string;
  /** The `createLogger` module tag (`capture`, `ipc`, `editor`…). */
  module: string;
  message: string;
  /** Already-redacted structured context, JSON-encoded. */
  context?: string | null;
}
