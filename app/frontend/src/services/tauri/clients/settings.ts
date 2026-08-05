/**
 * Settings IPC client.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so every consumer
 * (Providers.tsx, features/settings, future onboarding flow) imports from one
 * place — never from `features/settings/`. The wire-format types live in
 * `@clippity/shared` and are re-exported here; the UI-facing name-template
 * constants stay local to the frontend.
 *
 * Rust side: `domain::settings::*` + `services::settings_service::*`.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import type { AppIconStyle, Settings, SettingsPatch } from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::settings`) ----------
export type {
  ThemePref,
  RadiusScale,
  Density,
  AppIconStyle,
  WindowBackdrop,
  BackdropTuning,
  BackdropTuningSet,
  CaptureCompression,
  DeveloperExpiry,
  DeveloperSettings,
  LogLevel,
  GeneralSettings,
  AppearanceSettings,
  NotificationSettings,
  PerformanceSettings,
  CaptureSettings,
  RecordingSettings,
  ModelsSettings,
  ShortcutsSettings,
  Settings,
  SettingsPatch,
} from "@clippity/shared";

// ---------- Name-template constants (frontend-only UI helpers) ----------

/**
 * Built-in default file-name template, mirroring Rust
 * `domain::naming::DEFAULT_TEMPLATE`. Window-led, falling back to the
 * capture type, then a readable local date/time. Shown as the field
 * placeholder so a blank value reads as "uses the default".
 */
export const DEFAULT_NAME_TEMPLATE = "{label} - {date} {time}";

/** The tokens a name template understands, with human descriptions for
 *  the Settings → General help text. Order is display order. */
export const NAME_TEMPLATE_TOKENS: ReadonlyArray<{
  token: string;
  description: string;
}> = [
  {
    token: "{label}",
    description: "Window title, or the capture type if unknown",
  },
  { token: "{window}", description: "Active window title (blank if unknown)" },
  {
    token: "{type}",
    description: "Capture type (Fullscreen, Region, Window…)",
  },
  { token: "{date}", description: "Local date, e.g. 2026-06-13" },
  { token: "{time}", description: "Local time, e.g. 2.34.15 PM" },
];

// ---------- IPC wrappers ----------

/**
 * Snapshot the currently persisted settings. Returns the same shape
 * that `clippity://settings/changed` emits.
 *
 * Rust route: `app::commands::settings_get` →
 * `services::settings_service::SettingsService::snapshot`.
 */
export function getSettings(): Promise<Settings> {
  return invoke<Settings>("settings_get");
}

/**
 * Merge `patch` into persisted settings. Backend validates, writes to
 * disk, emits `clippity://settings/changed` with the full new state,
 * returns the same state. The frontend `useSettingsPatch` hook
 * mirrors the result back into the store optimistically.
 */
export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return invoke<Settings, { patch: SettingsPatch }>("settings_update", {
    patch,
  });
}

/**
 * Return the platform default captures directory (matches the backend
 * `AppPaths.captures` — typically `<app_data>/captures`). Used by the
 * onboarding wizard's Storage step so the user sees a real path as the
 * fallback hint instead of the bare word "default".
 *
 * Rust route: `app::commands::settings_default_captures_dir` →
 * `services::settings_service::SettingsService::fallback_captures_dir`.
 */
export function getDefaultCapturesDir(): Promise<string> {
  return invoke<string>("settings_default_captures_dir");
}

/**
 * Restart the whole application. Backs the Performance panel's "Restart
 * now" affordance — the GPU-acceleration browser arg is fixed when the
 * webview environment is created, so toggling it only takes hold on a
 * fresh process. The process is replaced, so the returned promise never
 * meaningfully resolves; don't chain work after it.
 *
 * Rust route: `app::commands::restart_app`.
 */
export function relaunchApp(): Promise<void> {
  return invoke<void>("restart_app");
}

/**
 * Swap the running process's icons (system tray + per-window taskbar) to
 * the chosen style. Best-effort on the Rust side — a decode/set failure
 * is logged and swallowed there, so callers fire-and-forget like
 * `apply_window_theme`. The built executable icon can't change at
 * runtime; this covers every icon the running process owns.
 *
 * Rust route: `app::commands::apply_app_icon`.
 */
export function applyAppIcon(style: AppIconStyle): Promise<void> {
  return invoke<void, { style: AppIconStyle }>("apply_app_icon", { style });
}

// ---------- Event listeners ----------

/**
 * Subscribe to `clippity://settings/changed`. Backend emits the full
 * new `Settings` after every successful `settings_update`. Returns a
 * sync unsubscribe — return it directly from a `useEffect`.
 *
 * NB: the local window that initiated the update ALSO receives this
 * event (Tauri's emitter is broadcast). That's fine — the store's
 * `setSettings` is idempotent.
 */
export function onSettingsChanged(
  handler: (settings: Settings) => void
): () => void {
  return on<Settings>(EVENT_NAMES.settingsChanged, handler);
}
