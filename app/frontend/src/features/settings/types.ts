/**
 * Settings feature — UI-local types + wire-type re-exports.
 *
 * Components import their types from here so the rest of the feature
 * never reaches into `@services/tauri/clients/settings` directly. If
 * the wire shape changes, the touchpoint is this one file.
 */

export type {
  AppearanceSettings,
  AppIconStyle,
  CaptureCompression,
  CaptureSettings,
  Density,
  GeneralSettings,
  ModelsSettings,
  NotificationSettings,
  PerformanceSettings,
  RadiusScale,
  RecordingSettings,
  Settings,
  SettingsPatch,
  ShortcutsSettings,
  ThemePref,
} from "@services/tauri/clients/settings";
export type {
  ToastCorner,
  ToastDurations,
} from "@services/tauri/clients/toast";

/** Category id for the left-rail navigation. */
export type SettingsCategory =
  | "general"
  | "appearance"
  | "notifications"
  | "performance"
  | "capture"
  | "recording"
  | "editor"
  | "library"
  | "shortcuts"
  | "models"
  | "integrations"
  | "privacy"
  | "advanced"
  | "about";
