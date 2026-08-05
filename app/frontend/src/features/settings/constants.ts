/**
 * Settings feature — static tables (categories, presets, duration
 * rows). Pure data; no React imports so the tables are tree-shake
 * friendly + unit-testable by inspection.
 */

import {
  Bell,
  Brain,
  Gauge,
  Info,
  Keyboard,
  Layers,
  Palette as PaletteIcon,
  PenLine,
  Plug,
  Settings as SettingsIcon,
  ShieldCheck,
  Sliders,
  Sparkles,
  Video,
  type LucideIcon,
} from "lucide-react";

import type {
  AppIconStyle,
  CaptureCompression,
  Density,
  DeveloperExpiry,
  LogLevel,
  RadiusScale,
  SettingsCategory,
  ToastCorner,
  ToastDurations,
  WindowBackdrop,
} from "./types";

export interface CategoryDef {
  id: SettingsCategory;
  label: string;
  icon: LucideIcon;
  /** Categories whose UI ships in this MVP. `false` renders the
   *  `ComingSoonPanel` placeholder. The wire shape is reserved
   *  regardless, so flipping `built: true` is a UI-only change once
   *  the owning port lands. */
  built: boolean;
  /** Short label rendered in the Coming Soon placeholder. */
  blockedBy?: string;
}

/** Order mirrors the legacy `SettingsView.tsx` so the navigation feels
 *  familiar to a returning user. */
export const CATEGORIES: readonly CategoryDef[] = [
  { id: "general", label: "General", icon: SettingsIcon, built: true },
  { id: "appearance", label: "Appearance", icon: PaletteIcon, built: true },
  { id: "notifications", label: "Notifications", icon: Bell, built: true },
  { id: "performance", label: "Performance", icon: Gauge, built: true },
  { id: "capture", label: "Capture", icon: Sparkles, built: true },
  { id: "recording", label: "Recording", icon: Video, built: true },
  {
    id: "editor",
    label: "Editor",
    icon: PenLine,
    built: false,
    blockedBy: "editor preferences",
  },
  {
    id: "library",
    label: "Library",
    icon: Layers,
    built: false,
    blockedBy: "library preferences",
  },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard, built: true },
  { id: "models", label: "Models", icon: Brain, built: true },
  {
    id: "integrations",
    label: "Integrations",
    icon: Plug,
    built: false,
    blockedBy: "app integrations",
  },
  {
    id: "privacy",
    label: "Privacy & Security",
    icon: ShieldCheck,
    built: false,
    blockedBy: "privacy controls",
  },
  { id: "advanced", label: "Advanced", icon: Sliders, built: true },
  {
    id: "about",
    label: "About",
    icon: Info,
    built: false,
  },
] as const;

/** Brand accent palette presets. Custom hex is allowed via the input. */
export interface AccentPreset {
  value: string;
  label: string;
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { value: "#FF6E4A", label: "Coral" },
  { value: "#2C3E3E", label: "Slate" },
  { value: "#A8D5D8", label: "Teal" },
  { value: "#E8D9F2", label: "Lavender" },
  { value: "#D4C5B0", label: "Gold" },
  { value: "#24D1B5", label: "Mint" },
] as const;

/** Corner-roundness options for the Appearance panel's segmented
 *  control. `value` mirrors the kebab-case wire shape of `RadiusScale`. */
export interface RadiusOption {
  value: RadiusScale;
  label: string;
}

export const RADIUS_OPTIONS: readonly RadiusOption[] = [
  { value: "sharp", label: "Sharp" },
  { value: "default", label: "Default" },
  { value: "round", label: "Round" },
] as const;

/** UI-density options for the Appearance panel's segmented control.
 *  `value` mirrors the kebab-case wire shape of `Density`. */
export interface DensityOption {
  value: Density;
  label: string;
  hint: string;
}

export const DENSITY_OPTIONS: readonly DensityOption[] = [
  { value: "comfortable", label: "Comfortable", hint: "Roomy · the default" },
  { value: "compact", label: "Compact", hint: "Tighter · more on screen" },
] as const;

/** App-icon style options for the Appearance panel's picker. `value`
 *  mirrors the kebab-case wire shape of `AppIconStyle`. */
export interface AppIconOption {
  value: AppIconStyle;
  label: string;
  hint: string;
}

export const APP_ICON_OPTIONS: readonly AppIconOption[] = [
  { value: "color", label: "Colour", hint: "Full-colour mark" },
  { value: "monochrome", label: "Monochrome", hint: "Single-hue glyph" },
] as const;

/** Native window-backdrop options. `value` mirrors the kebab-case wire
 *  shape of `WindowBackdrop`. The Performance tab's "Transparency &
 *  blur effects" switch remains the master on/off control. */
export interface WindowBackdropOption {
  value: WindowBackdrop;
  label: string;
  hint: string;
}

export const WINDOW_BACKDROP_OPTIONS: readonly WindowBackdropOption[] = [
  {
    value: "mica",
    label: "Mica",
    hint: "Wallpaper-tinted material; not live desktop blur",
  },
  { value: "acrylic", label: "Acrylic", hint: "True translucent blur" },
  {
    value: "blur",
    label: "Blur",
    hint: "Legacy Windows blur; varies by build",
  },
  {
    value: "tabbed",
    label: "Tabbed",
    hint: "Tabbed Mica material; not live desktop blur",
  },
  {
    value: "clear",
    label: "Clear",
    hint: "No material — the desktop shows through unblurred",
  },
] as const;

// The per-material tuning tables + helpers live in `lib/backdrop.ts` —
// `Providers.tsx` needs them on every window and shouldn't drag this
// icon-laden module into every bundle to get them.

/** Chrome-opacity slider envelope, in percent. Mirrors the Rust
 *  `domain::settings::{MIN,MAX}_WINDOW_OPACITY_PCT` clamp — keep in
 *  lock-step. */
export const WINDOW_OPACITY_MIN_PCT = 10;
export const WINDOW_OPACITY_MAX_PCT = 100;
export const WINDOW_OPACITY_STEP_PCT = 1;

/** UI-scale slider envelope, in percent. Mirrors the Rust
 *  `domain::settings::{MIN,MAX}_UI_SCALE_PCT` clamp — keep in lock-step. */
export const UI_SCALE_MIN_PCT = 80;
export const UI_SCALE_MAX_PCT = 120;
export const UI_SCALE_STEP_PCT = 5;

/** Anchor-corner options for the toast placement picker. */
export interface CornerOption {
  value: ToastCorner;
  label: string;
}

export const CORNER_OPTIONS: readonly CornerOption[] = [
  { value: "top-left", label: "Top-left" },
  { value: "top-right", label: "Top-right" },
  { value: "bottom-left", label: "Bottom-left" },
  { value: "bottom-right", label: "Bottom-right" },
] as const;

/** Capture-compression options for the Performance panel's segmented
 *  control. `value` mirrors the kebab-case wire shape of
 *  `CaptureCompression`; `Balanced` is the historic default. */
export interface CaptureCompressionOption {
  value: CaptureCompression;
  label: string;
  hint: string;
}

export const CAPTURE_COMPRESSION_OPTIONS: readonly CaptureCompressionOption[] =
  [
    { value: "fast", label: "Fast", hint: "Quickest save · larger files" },
    { value: "balanced", label: "Balanced", hint: "Default · speed vs size" },
    { value: "small", label: "Smaller", hint: "Slowest save · smallest files" },
  ] as const;

/** Notification duration rows. `key` mirrors the kebab-case wire shape
 *  of `ToastDurations`. `armed` marks variants whose owning port has
 *  already shipped; reserved variants render with a visual cue but
 *  still accept user input so the value persists for the day their
 *  port lands. */
export interface DurationRow {
  key: keyof ToastDurations;
  label: string;
  description: string;
  armed: boolean;
}

export const DURATION_ROWS: readonly DurationRow[] = [
  {
    key: "error",
    label: "Capture failed",
    description: "Error toasts (capture, OCR, future ports).",
    armed: true,
  },
  {
    key: "clipboard",
    label: "Clipboard captured",
    description: "Image / text ingested from the clipboard.",
    armed: true,
  },
  {
    key: "color",
    label: "Color picked",
    description: "Hex / RGB readout after a color pick.",
    armed: true,
  },
  {
    key: "palette",
    label: "Palette extracted",
    description: "Swatches after a palette capture.",
    armed: true,
  },
  {
    key: "text",
    label: "Text grabbed",
    description: "OCR result after Grab Text.",
    armed: true,
  },
  {
    key: "recording",
    label: "Recording in progress",
    description: "Scrolling / panoramic capture controls.",
    armed: true,
  },
] as const;

/** Slider envelope, in ms. `0` is the "Sticky" semantic. Step is
 *  500 ms — matches what's perceivable. */
export const DURATION_MIN_MS = 0;
export const DURATION_MAX_MS = 15_000;
export const DURATION_STEP_MS = 500;

/** Capture-delay stepper envelope, in seconds. Mirrors the Rust
 *  `domain::settings::{MIN,MAX}_DELAY_SECONDS` clamp and the capture
 *  store's own `MIN_DELAY`/`MAX_DELAY` — keep the three in lock-step. */
export const CAPTURE_DELAY_MIN_S = 1;
export const CAPTURE_DELAY_MAX_S = 60;

/** Palette swatch-count stepper envelope. Mirrors the Rust
 *  `domain::palette::{MIN,MAX}_PALETTE_COUNT` clamp. */
export const PALETTE_COUNT_MIN = 2;
export const PALETTE_COUNT_MAX = 16;

/** Recording frame-rate envelopes. Mirrors the Rust
 *  `domain::recorder::{MP4,GIF}_FPS_{MIN,MAX}` clamp — the two ranges
 *  differ because GIF stores its delay in centiseconds, so a high rate
 *  rounds to a delay viewers substitute their own value for. */
export const VIDEO_FPS_MIN = 10;
export const VIDEO_FPS_MAX = 60;
export const GIF_FPS_MIN = 5;
export const GIF_FPS_MAX = 30;

/** Audio-gain envelope, as a percentage of unity. Mirrors the Rust
 *  `domain::recorder::{GAIN_PCT_DEFAULT,GAIN_PCT_MAX}` clamp.
 *
 *  The floor is 0 (silence — what mute sends) and the ceiling is +6 dB;
 *  past that a bigger number buys distortion rather than volume, because
 *  the mix is clamped to full scale on its way to 16-bit PCM. */
export const GAIN_MIN_PCT = 0;
export const GAIN_MAX_PCT = 200;
export const GAIN_DEFAULT_PCT = 100;
export const GAIN_STEP_PCT = 5;
/** Ticks every 50% — unity lands on one, which is what makes "back to
 *  normal" findable by eye during a drag. */
export const GAIN_TICK_STEP_PCT = 50;

/** Encoder-quality steps. Mirrors `domain::recorder::RecorderQuality`,
 *  whose bits-per-pixel table is the thing that actually differs —
 *  these labels describe the trade in the terms a user makes it in. */
export const QUALITY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "efficient", label: "Efficient — smaller files" },
  { value: "balanced", label: "Balanced (recommended)" },
  { value: "high", label: "High — larger files" },
];

/** Rate-control modes. Mirrors `domain::recorder::RateControl`. */
export const RATE_CONTROL_OPTIONS: readonly {
  value: string;
  label: string;
}[] = [
  { value: "variable", label: "Variable — smaller files" },
  { value: "constant", label: "Constant — predictable size" },
];

/** Keyframe-interval envelope in seconds. Mirrors
 *  `domain::recorder::KEYFRAME_SECONDS_{MIN,MAX}`. */
export const KEYFRAME_SECONDS_MIN = 1;
export const KEYFRAME_SECONDS_MAX = 10;

/** Bitrate-override envelope in **megabits** per second — the unit the
 *  field is typed in. Mirrors `domain::recorder::BITRATE_{MIN,MAX}_BPS`
 *  (1.5–60 Mbps); the backend clamps in bits, so the field rounds up to
 *  2 rather than offering a value that would be clamped on arrival. */
export const BITRATE_MIN_MBPS = 2;
export const BITRATE_MAX_MBPS = 60;

/** Most sources one recording may carry. Mirrors
 *  `domain::composition::MAX_SOURCES`. */
export const MAX_SOURCES = 8;

/** Where a source sits, as a fraction of the recorded frame.
 *
 *  Corners rather than free positioning: dragging wants a live preview
 *  of the frame, and a recording's frame is whatever the user is about
 *  to point at — which does not exist while this panel is open. A
 *  quarter-width box in a corner is what people actually do with a
 *  webcam, and because the rect is normalized the same choice lands
 *  correctly on any region or monitor. */
export const CORNER_PRESETS: readonly {
  key: string;
  label: string;
  rect: { x: number; y: number; w: number; h: number };
}[] = [
  {
    key: "tl",
    label: "Top left",
    rect: { x: 0.03, y: 0.04, w: 0.25, h: 0.25 },
  },
  {
    key: "tr",
    label: "Top right",
    rect: { x: 0.72, y: 0.04, w: 0.25, h: 0.25 },
  },
  {
    key: "bl",
    label: "Bottom left",
    rect: { x: 0.03, y: 0.71, w: 0.25, h: 0.25 },
  },
  {
    key: "br",
    label: "Bottom right",
    rect: { x: 0.72, y: 0.71, w: 0.25, h: 0.25 },
  },
] as const;

/** Sentinel for "encode at whatever was captured". Mirrors the Rust
 *  `domain::recorder::RESOLUTION_SOURCE`. */
export const RESOLUTION_SOURCE = 0;

/** Output-resolution menu, high to low. Mirrors
 *  `domain::recorder::RESOLUTION_CHOICES`, plus the source entry.
 *
 *  Heights, not `width×height` pairs: a recording's aspect ratio comes
 *  from the region the user picked, and stating a width would either
 *  letterbox an ultrawide clip or promise dimensions no session has.
 *  The cap only ever shrinks — a region shorter than the chosen height
 *  is left alone rather than upscaled. */
export const RESOLUTION_OPTIONS: readonly { value: number; label: string }[] = [
  { value: RESOLUTION_SOURCE, label: "Same as source" },
  { value: 2160, label: "2160p (4K)" },
  { value: 1440, label: "1440p (QHD)" },
  { value: 1080, label: "1080p (Full HD)" },
  { value: 720, label: "720p (HD)" },
  { value: 480, label: "480p" },
];

// ---------- Developer & diagnostics (Settings → Advanced) ----------

/** Log-level choices, least to most verbose. `value` mirrors the
 *  kebab-case wire shape of `LogLevel`; the hint says what each level
 *  costs, because "trace" on a recording session is a real decision. */
export interface LogLevelOption {
  value: LogLevel;
  label: string;
  hint: string;
}

export const LOG_LEVEL_OPTIONS: readonly LogLevelOption[] = [
  { value: "off", label: "Off", hint: "Record nothing" },
  { value: "error", label: "Error", hint: "Failures only" },
  { value: "warn", label: "Warning", hint: "Failures + suspicions" },
  { value: "info", label: "Info", hint: "What the app did" },
  { value: "debug", label: "Debug", hint: "Verbose — for reproducing a bug" },
  { value: "trace", label: "Trace", hint: "Everything — very noisy" },
] as const;

/** How long an armed developer mode survives. `value` mirrors the
 *  kebab-case wire shape of `DeveloperExpiry`. */
export interface DeveloperExpiryOption {
  value: DeveloperExpiry;
  label: string;
  hint: string;
}

export const DEVELOPER_EXPIRY_OPTIONS: readonly DeveloperExpiryOption[] = [
  { value: "restart", label: "Until restart", hint: "The default" },
  { value: "day", label: "For 24 hours", hint: "From when it was armed" },
  { value: "never", label: "Until turned off", hint: "Stays armed" },
] as const;

/** Log-file size envelope, in MiB. Mirrors the Rust
 *  `domain::settings::{MIN,MAX}_LOG_FILE_MB` clamp. */
export const LOG_FILE_MB_MIN = 1;
export const LOG_FILE_MB_MAX = 64;

/** Retained rotated files. Mirrors `{MIN,MAX}_LOG_FILES`. */
export const LOG_FILES_MIN = 1;
export const LOG_FILES_MAX = 20;

/** Slow-command threshold choices, in ms. 16 ms is one frame at 60 Hz —
 *  the point past which a command can cost a dropped frame. Mirrors the
 *  Rust `{MIN,MAX}_SLOW_COMMAND_MS` envelope. */
export const SLOW_COMMAND_OPTIONS: readonly { value: number; label: string }[] =
  [
    { value: 16, label: "16 ms — one frame" },
    { value: 50, label: "50 ms" },
    { value: 100, label: "100 ms (default)" },
    { value: 500, label: "500 ms" },
    { value: 1000, label: "1 s" },
  ];

/** How many log lines the live viewer holds. Past a couple of thousand
 *  the webview is the bottleneck, not the disk — and the backend caps
 *  the request at the same number. */
export const LOG_VIEW_LINES = 400;

/** How often the live log viewer re-reads the tail, in ms. Slow enough
 *  that watching the log doesn't itself become the load being watched. */
export const LOG_POLL_MS = 1500;

/** How often the live performance overlay samples, in ms. */
export const PERF_SAMPLE_MS = 500;

/** Detection-confidence slider envelope, in percent. Mirrors the Rust
 *  `domain::settings::{MIN,MAX}_CONFIDENCE_PCT` clamp — coordinate in
 *  lock-step. */
export const CONFIDENCE_MIN_PCT = 5;
export const CONFIDENCE_MAX_PCT = 95;
export const CONFIDENCE_STEP_PCT = 5;
/** Spacing between the slider's interval tick lines (every 20%: ticks
 *  land on 20/40/60/80 inside the 5–95 range). */
export const CONFIDENCE_TICK_STEP_PCT = 20;
