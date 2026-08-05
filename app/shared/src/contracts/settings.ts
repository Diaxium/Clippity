/**
 * Settings wire-format contracts — mirror Rust `domain::settings`.
 *
 * Persisted sections: `general`, `appearance`, `notifications`,
 * `performance`, `capture`, `models`, and `shortcuts`. The remaining
 * reserved section (`editor`) is intentionally absent on this wire shape;
 * the serde `default` cascade on the Rust side keeps adding it
 * forward-compatible.
 */

import type { Source } from "./composition";
import type { RecorderEncoding } from "./recorder";
import type { ScrollDirection } from "./scroll";
import type { ToastCorner, ToastDurations } from "./toast";

export type ThemePref = "light" | "dark" | "system";

/** Corner-roundness scale for the `--radius-*` token family. Mirrors the
 *  Rust `domain::settings::RadiusScale` (kebab-case on the wire). */
export type RadiusScale = "sharp" | "default" | "round";

/** Spacing density for the full-window chrome. Mirrors the Rust
 *  `domain::settings::Density`. */
export type Density = "comfortable" | "compact";

/** Application-icon style — which bundled mark drives the tray / taskbar
 *  / in-app icon. Mirrors the Rust `domain::settings::AppIconStyle`. */
export type AppIconStyle = "color" | "monochrome";

/** Native window backdrop material for transparent app chrome. Mirrors
 *  Rust `domain::settings::WindowBackdrop` (kebab-case on the wire).
 *
 *  `mica` / `tabbed` are wallpaper-derived — DWM blurs the desktop
 *  wallpaper, so live content behind the window never shows through
 *  however transparent the chrome is made. `acrylic` / `blur` sample
 *  live content. `clear` removes the material entirely, leaving the
 *  transparent window as a plain hole onto whatever is behind it. */
export type WindowBackdrop =
  | "mica"
  | "acrylic"
  | "blur"
  | "tabbed"
  | "clear";

/**
 * Per-material fine-tuning. Mirrors Rust `domain::settings::BackdropTuning`.
 * Every field is a percent; the backend clamps each into its envelope on
 * save (see `settings/constants.ts` for the mirrored bounds).
 *
 * - `tintStrength` (0–100) — alpha of the colour blended into the
 *   *native* material. Only Acrylic and Blur take one; on Windows 11
 *   22H2+ acrylic is a DWM system backdrop that tints itself, so this
 *   lands on Windows 10 / older builds only.
 * - `glassStrength` (0–150) — multiplier on the stacked in-app glass
 *   layers. The knob that decides how much of the native material is
 *   visible through the app's own panels; 0 stops them painting.
 * - `blurStrength` (0–200) — multiplier on the CSS `backdrop-filter`
 *   blur radii. Lower reads sharper through the chrome.
 * - `saturation` (50–200) — CSS `backdrop-filter: saturate()`. Pushes
 *   colour back into materials that wash out under transparent chrome.
 */
export interface BackdropTuning {
  tintStrength: number;
  glassStrength: number;
  blurStrength: number;
  saturation: number;
}

/** One `BackdropTuning` per material, so switching backdrops restores
 *  that material's own numbers. Mirrors Rust
 *  `domain::settings::BackdropTuningSet`. */
export type BackdropTuningSet = Record<WindowBackdrop, BackdropTuning>;

/** PNG encoding effort for the capture-save pipeline. Mirrors the Rust
 *  `domain::settings::CaptureCompression` (kebab-case on the wire). */
export type CaptureCompression = "fast" | "balanced" | "small";

export interface GeneralSettings {
  /** User-chosen captures dir; empty string = use backend fallback. */
  capturesDir: string;
  /**
   * Capture file-name template. Empty string = the backend's built-in
   * default (`DEFAULT_NAME_TEMPLATE`). Tokens: `{label}` `{window}`
   * `{type}` `{date}` `{time}` — see `NAME_TEMPLATE_TOKENS`.
   */
  nameTemplate: string;
  /** Seeded on first launch from the installer's "Start Clippity at login"
   *  answer; editable afterwards like any other setting. */
  startOnStartup: boolean;
  /**
   * Whether Clippity may check for and apply updates on its own. Seeded on
   * first launch from the installer's answer. **Intent only in this build**
   * — there is no updater yet, so nothing acts on it.
   */
  automaticUpdates: boolean;
  /**
   * Whether Clippity may share anonymous usage and diagnostic data. Seeded
   * on first launch from the installer's answer. **Intent only in this
   * build** — Clippity sends no telemetry.
   */
  helpImprove: boolean;
  /** True once the user has completed the first-launch onboarding
   *  wizard. AppShell gates the wizard on `!onboarded`. */
  onboarded: boolean;
}

export interface AppearanceSettings {
  theme: ThemePref;
  /** Accent color hex (`#RRGGBB`, 6-digit uppercase or lowercase). */
  accent: string;
  /**
   * Chrome opacity, percent (10–100). Drives transparency paint tokens in
   * `theme.css` so the native backdrop / desktop bleeds through the
   * window shell. Backend clamps into `[MIN,MAX]_WINDOW_OPACITY_PCT` on save.
   */
  windowOpacity: number;
  /** Native material behind the translucent app chrome. */
  windowBackdrop: WindowBackdrop;
  /** Per-material fine-tuning for `windowBackdrop`. */
  backdropTuning: BackdropTuningSet;
  /**
   * UI zoom, percent (80–120). Applied as a CSS `zoom` on the full-window
   * chrome (main / capture) so px type + layout scale together — kept off
   * the coordinate-sensitive overlay + backend-sized utility windows.
   * Backend clamps into `[MIN,MAX]_UI_SCALE_PCT` on save.
   */
  uiScale: number;
  /** Corner-roundness scale for the `--radius-*` token family. */
  cornerRadius: RadiusScale;
  /** Spacing density for the full-window chrome. */
  density: Density;
  /** Which bundled mark drives the tray / taskbar / in-app icon. */
  appIcon: AppIconStyle;
}

export interface NotificationSettings {
  corner: ToastCorner;
  durations: ToastDurations;
}

/**
 * Performance / rendering knobs. Mirrors Rust
 * `domain::settings::PerformanceSettings`.
 *
 * - `gpuAcceleration`: WebView2 GPU rendering. The backend reads this at
 *   process start to set a `--disable-gpu` browser arg, so a change only
 *   takes effect after an app restart.
 * - `windowEffects`: Win11 Mica backdrop + `backdrop-filter` blur. Off =
 *   flat opaque chrome, lighter on the DWM compositor + GPU. Live.
 * - `reducedAnimations`: the single motion master — `Providers.tsx`
 *   maps it onto `data-motion` (ORed with the OS `prefers-reduced-motion`).
 * - `captureCompression`: PNG encode effort for the capture pipeline.
 */
export interface PerformanceSettings {
  gpuAcceleration: boolean;
  windowEffects: boolean;
  reducedAnimations: boolean;
  captureCompression: CaptureCompression;
}

/**
 * Capture-behaviour knobs — the defaults a fresh capture window opens
 * with. Mirrors Rust `domain::settings::CaptureSettings`. The capture
 * window seeds its per-session store from these on launch, so a user's
 * preferred toggles / delay survive restarts.
 *
 * - `preview` / `clipboard` / `cursor` / `enhance`: the four capture
 *   option toggles. `preview` ships on; the rest ship off.
 * - `delay` / `delaySeconds`: the pre-capture countdown default and its
 *   length. The backend clamps `delaySeconds` (1–60) on save.
 * - `scrollDirection`: default axis for Scrolling-Window / Panoramic.
 * - `paletteCount`: default swatch count a Palette capture extracts. The
 *   backend clamps it (2–16) on read.
 */
export interface CaptureSettings {
  preview: boolean;
  clipboard: boolean;
  cursor: boolean;
  enhance: boolean;
  delay: boolean;
  delaySeconds: number;
  scrollDirection: ScrollDirection;
  paletteCount: number;
}

/**
 * Screen-recording defaults (ADR 0031). Mirrors Rust
 * `domain::settings::RecordingSettings`.
 *
 * Its own section rather than fields on `CaptureSettings`: a recording
 * answers different questions than a still, and shares none of that
 * struct's toggles.
 *
 * - `microphone` / `systemAudio`: which inputs to mix in. **Both ship
 *   off** — a recorder that silently starts listening to the room, or
 *   captures whatever music is playing, is a privacy surprise rather
 *   than a convenience.
 * - `microphoneDevice` / `systemDevice`: pinned endpoint ids, or null to
 *   follow the OS default (which is what survives plugging in a headset
 *   mid-session).
 * - `microphoneGainPct` / `systemGainPct`: the level each input *starts*
 *   a session at, as a percentage of unity (100 = unchanged, 0 = silent,
 *   200 = the ceiling). The HUD's live sliders move the running session
 *   and deliberately do not write back here — a level nudged for one
 *   recording shouldn't become the level every future one begins at.
 * - `videoFps` / `gifFps`: separate because GIF's usable frame-rate
 *   range is far lower. The backend clamps both on save.
 * - `maxHeight`: cap on the encoded frame's height. `0` records at the
 *   captured size and is the default. One value across both formats,
 *   unlike the frame rates — GIF's own pixel budget is tighter than any
 *   offered height and simply wins, so a shared setting can't produce a
 *   value either format refuses.
 * - `encoding`: H.264 encoder settings a session starts from — quality
 *   step, optional fixed bitrate, keyframe interval, rate control, and
 *   the hardware-encoder preference. Nested rather than five flat fields
 *   because they are read together and mean nothing individually. GIF
 *   ignores all of it.
 * - `cursor`: composite the pointer into recorded frames.
 * - `outline`: draw a border around the recorded area for the length of
 *   the session. **Ships on** — between choosing a region and stopping,
 *   nothing else says what is being recorded. Click-through and excluded
 *   from capture, so it never lands in the file.
 * - `clipboard`: copy every finished clip to the clipboard as a file
 *   reference. **Ships off**, matching `CaptureSettings.clipboard` —
 *   replacing what the user had copied is a surprise either way.
 */
export interface RecordingSettings {
  microphone: boolean;
  systemAudio: boolean;
  microphoneDevice?: string | null;
  systemDevice?: string | null;
  microphoneGainPct: number;
  systemGainPct: number;
  videoFps: number;
  gifFps: number;
  maxHeight: number;
  encoding: RecorderEncoding;
  sources: Source[];
  cursor: boolean;
  outline: boolean;
  clipboard: boolean;
}

/**
 * AI-model preferences. Mirrors Rust `domain::settings::ModelsSettings`.
 *
 * - `autoDownload`: fetch a feature's model automatically the first time
 *   the feature is armed, instead of bouncing the user to Settings → Models.
 * - `objectModel`: registry id of the detector backing the Object capture
 *   mode (`ui-elements` | `yolov10n` | `yolov10s`). The backend falls back
 *   to its default when the id is stale.
 * - `confidence`: detector confidence threshold in percent (clamped 5–95
 *   backend-side).
 */
export interface ModelsSettings {
  autoDownload: boolean;
  objectModel: string;
  confidence: number;
}

/**
 * Keyboard-shortcut customization. Mirrors Rust
 * `domain::settings::ShortcutsSettings`.
 *
 * - `overrides`: per-binding remaps for the in-app keybind registries.
 *   The key is a fully-qualified binding id — `"<scope>:<id>"`, e.g.
 *   `"editor:select-all"`, `"library:trash-selection"`,
 *   `"quickCapture:screenshot"` — and the value is the list of combos
 *   (author notation, `"Mod+Shift+A"`) that *replace* that binding's
 *   registry default. A missing id = "use the default"; an explicit empty
 *   array = "deliberately unbound".
 * - `globalCapture`: the OS-global accelerator (same `Mod+Shift+Key`
 *   notation) that opens the region-capture overlay from anywhere. Empty
 *   = none. The backend registers it via `tauri-plugin-global-shortcut`.
 * - `globalCaptureEnabled`: master switch for the global accelerator.
 */
export interface ShortcutsSettings {
  overrides: Record<string, string[]>;
  globalCapture: string;
  globalCaptureEnabled: boolean;
}

/**
 * Severity floor for one half of the app's logging. Mirrors the Rust
 * `domain::settings::LogLevel` (kebab-case on the wire) — the backend
 * maps it onto a `tracing` `EnvFilter` directive, the frontend onto its
 * console logger's threshold, so both halves of a log file agree on
 * what "debug" means.
 */
export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

/**
 * How long an armed developer mode survives. Mirrors the Rust
 * `domain::settings::DeveloperExpiry`. `restart` is the default —
 * developer mode reveals destructive actions and can record IPC
 * payloads, so leaving it armed after one debugging session is the
 * failure mode this guards against.
 */
export type DeveloperExpiry = "never" | "restart" | "day";

/**
 * Developer + diagnostics preferences — Settings → Advanced. Mirrors
 * Rust `domain::settings::DeveloperSettings`.
 *
 * Two kinds of field, and the difference matters:
 *
 * - **Presentation gates** (`enabled`, `showActions`, `performanceOverlay`,
 *   the per-area diagnostics toggles) decide what the UI reveals; they
 *   are inert while developer mode is off.
 * - **Machinery** (`backendLog`, `frontendLog`, `logToDisk`,
 *   `logMaxFileMb`, `logRetainFiles`) configures logging on **every**
 *   launch, developer mode or not — which is what makes an exported
 *   diagnostics bundle worth anything for a user who never opened this
 *   page.
 */
export interface DeveloperSettings {
  /** Master switch. Ships off. */
  enabled: boolean;
  /** Epoch ms at which developer mode was last armed; `0` = unknown,
   *  which the `day` policy treats as expired rather than as forever. */
  enabledAtMs: number;
  expiry: DeveloperExpiry;
  /** Surface developer actions in ordinary context menus too. */
  showActions: boolean;
  /** Ask before a destructive developer action runs. Ships on. */
  confirmDestructive: boolean;
  devtoolsOnStartup: boolean;
  /** Severity floor for the Rust `tracing` subscriber. */
  backendLog: LogLevel;
  /** Severity floor for the frontend logger, and for what it forwards
   *  into the backend's log file. */
  frontendLog: LogLevel;
  /** Write the log to rotating files under `<data>/logs`. Ships on. */
  logToDisk: boolean;
  /** Size at which the live log file rotates, in MiB (1–64). */
  logMaxFileMb: number;
  /** Rotated files kept beside the live one (1–20). */
  logRetainFiles: number;
  performanceOverlay: boolean;
  /** Record duration / payload size / outcome of every IPC call so the
   *  command inspector has something to show. Off by default. */
  commandTiming: boolean;
  /** Flag any command slower than this, in ms (1–5000). */
  slowCommandMs: number;
  /** Show capture timing + monitor/DPI/HDR diagnostics. */
  captureDiagnostics: boolean;
  /** Show recorder statistics (frames, drops, encoder, file growth). */
  recordingDiagnostics: boolean;
  /** Strip user names, paths and capture names from an exported
   *  bundle. Ships on — a bundle is made to be sent to someone else. */
  redactDiagnostics: boolean;
  /** Per-flag overrides for the frontend's experiment registry. A
   *  missing id = "use the build default". */
  featureFlags: Record<string, boolean>;
}

/**
 * The shipped developer defaults, mirroring Rust
 * `DeveloperSettings::default()`.
 *
 * A value rather than a type because three surfaces need one: test
 * fixtures, the settings smoke page, and any future code that has to
 * construct a full `Settings` without a backend. Keep it in lock-step
 * with the Rust `Default` impl — the Rust side is authoritative, and
 * this exists so nothing has to guess at what it says.
 */
export const DEFAULT_DEVELOPER_SETTINGS: DeveloperSettings = {
  enabled: false,
  enabledAtMs: 0,
  expiry: "restart",
  showActions: false,
  confirmDestructive: true,
  devtoolsOnStartup: false,
  backendLog: "info",
  frontendLog: "warn",
  logToDisk: true,
  logMaxFileMb: 8,
  logRetainFiles: 5,
  performanceOverlay: false,
  commandTiming: false,
  slowCommandMs: 100,
  captureDiagnostics: false,
  recordingDiagnostics: false,
  redactDiagnostics: true,
  featureFlags: {},
};

export interface Settings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
  performance: PerformanceSettings;
  capture: CaptureSettings;
  recording: RecordingSettings;
  models: ModelsSettings;
  shortcuts: ShortcutsSettings;
  developer: DeveloperSettings;
}

/**
 * Patch shape for `settings_update`. Each section is optional and
 * replaces the whole sub-struct when present — omit a section to
 * leave it unchanged.
 */
export interface SettingsPatch {
  general?: GeneralSettings;
  appearance?: AppearanceSettings;
  notifications?: NotificationSettings;
  performance?: PerformanceSettings;
  capture?: CaptureSettings;
  recording?: RecordingSettings;
  models?: ModelsSettings;
  shortcuts?: ShortcutsSettings;
  developer?: DeveloperSettings;
}
