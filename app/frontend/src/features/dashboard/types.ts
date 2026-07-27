/**
 * Dashboard feature types. The "dashboard" is the main window's
 * internal routing concept — Home / Library / Editor / Settings /
 * Presets as views inside one window, matching the legacy MainWindow.
 *
 * This is a *superset* of the cross-window IPC `DashboardView` in
 * `@services/tauri/clients/dashboard`: `home` is the local landing
 * view and is never a cross-window navigation target, so it is added
 * here without touching the wire contract in `@clippity/shared`. Every
 * value the IPC layer can send (`library`, `editor`, `settings`,
 * `presets`, `palette`) is still present, so events from that layer
 * assign into this type cleanly.
 */

export type DashboardView =
  | "home"
  | "library"
  | "editor"
  | "settings"
  | "presets"
  | "palette";
