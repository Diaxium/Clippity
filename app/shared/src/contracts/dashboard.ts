/**
 * Dashboard cross-window handoff contracts — mirror Rust
 * `domain::dashboard`.
 *
 * The "dashboard" is the main window's internal-routing concept —
 * Library / Editor / Settings are views rendered inside one window.
 */

/**
 * `studio` is the video surface, and is a peer of `editor` rather than a
 * mode of it. The two share a job description — explain a captured
 * moment — and almost no machinery: the editor's document is a scene
 * graph of shapes over a still, Studio's is a clip with a playhead and a
 * range. Threading a time axis through every image-only code path to
 * merge them would cost more than the components they'd share.
 */
export type DashboardView =
  "library" | "editor" | "studio" | "settings" | "presets" | "palette";

export interface DashboardRequest {
  view: DashboardView;
  captureId: string | null;
}
