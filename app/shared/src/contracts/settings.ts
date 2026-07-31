/**
 * Settings wire-format contracts — mirror Rust `domain::settings`.
 *
 * Persisted sections: `general`, `appearance`, `notifications`,
 * `performance`, `capture`, `models`, and `shortcuts`. The remaining
 * reserved section (`editor`) is intentionally absent on this wire shape;
 * the serde `default` cascade on the Rust side keeps adding it
 * forward-compatible.
 */

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
   * Chrome opacity, percent (60–100). Drives `--window-opacity` in
   * `theme.css` so the Mica backdrop / desktop bleeds through the window
   * shell. Backend clamps into `[MIN,MAX]_WINDOW_OPACITY_PCT` on save.
   */
  windowOpacity: number;
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
 * - `videoFps` / `gifFps`: separate because GIF's usable frame-rate
 *   range is far lower. The backend clamps both on save.
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
  videoFps: number;
  gifFps: number;
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

export interface Settings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
  notifications: NotificationSettings;
  performance: PerformanceSettings;
  capture: CaptureSettings;
  recording: RecordingSettings;
  models: ModelsSettings;
  shortcuts: ShortcutsSettings;
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
}
