/**
 * Dashboard cross-window handoff contracts — mirror Rust
 * `domain::dashboard`.
 *
 * The "dashboard" is the main window's internal-routing concept —
 * Library / Editor / Settings are views rendered inside one window.
 */

export type DashboardView = "library" | "editor" | "settings" | "presets" | "palette";

export interface DashboardRequest {
  view: DashboardView;
  captureId: string | null;
}
