/**
 * Window labels and hash routes — single source of truth shared
 * between `App.tsx`'s router, the Tauri config, and any service that
 * needs to show/focus a window.
 *
 * Keep this in sync with `backend/tauri.conf.json` `app.windows[*].label`.
 */

export const WINDOW_LABELS = {
  capture: "capture",
  main: "main",
  countdown: "countdown",
  overlay: "overlay",
  toast: "toast",
  tray: "tray",
} as const;

export type WindowLabel = (typeof WINDOW_LABELS)[keyof typeof WINDOW_LABELS];

/**
 * Hash routes parsed from `window.location.hash`. The default (no
 * hash) resolves to the capture window, matching the default Tauri
 * window URL `index.html`.
 */
export const ROUTES = {
  capture: "",
  main: "/main",
  countdown: "/countdown",
  overlay: "/overlay",
  toast: "/toast",
  tray: "/tray",
  /** Click-through border framing the area a recording is capturing. */
  recorderFrame: "/recorder-frame",
} as const;
