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
  RadiusScale,
  SettingsCategory,
  ToastCorner,
  ToastDurations,
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
  {
    id: "advanced",
    label: "Advanced",
    icon: Sliders,
    built: false,
    blockedBy: "advanced options",
  },
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

/** Chrome-opacity slider envelope, in percent. Mirrors the Rust
 *  `domain::settings::{MIN,MAX}_WINDOW_OPACITY_PCT` clamp — keep in
 *  lock-step. */
export const WINDOW_OPACITY_MIN_PCT = 60;
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

/** Detection-confidence slider envelope, in percent. Mirrors the Rust
 *  `domain::settings::{MIN,MAX}_CONFIDENCE_PCT` clamp — coordinate in
 *  lock-step. */
export const CONFIDENCE_MIN_PCT = 5;
export const CONFIDENCE_MAX_PCT = 95;
export const CONFIDENCE_STEP_PCT = 5;
/** Spacing between the slider's interval tick lines (every 20%: ticks
 *  land on 20/40/60/80 inside the 5–95 range). */
export const CONFIDENCE_TICK_STEP_PCT = 20;
