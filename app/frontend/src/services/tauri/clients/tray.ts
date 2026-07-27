/**
 * Tray IPC client + event wrappers.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/`. The tray
 * flyout's action buttons reuse the capture / overlay / countdown /
 * library / dashboard clients; this file holds only the tray-specific
 * surface — dismiss the panel, quit the app, and the "panel opened"
 * event the backend emits after positioning + showing it.
 *
 * Imported by full path (like `countdown` / `settings`) rather than the
 * cross-feature barrel, because only `features/tray` consumes it.
 *
 * Rust side: `services::tray_service` + `app::commands::{hide_tray_panel,
 * quit_app}`. See [ADR 0003](../../../../docs/decisions/0003-tray-flyout-panel.md).
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";

// ---------- IPC wrappers ----------

/**
 * Hide the flyout panel. Call after an action fires (to get the panel
 * out of the way / out of a fullscreen shot) or on Esc. The backend
 * runs a compositor settle when it actually took the panel off-screen,
 * so awaiting this before a capture guarantees the panel isn't in the
 * frame even though it isn't a primary window. Idempotent.
 */
export function hideTrayPanel(): Promise<void> {
  return invoke<void>("hide_tray_panel");
}

/**
 * Quit the whole application. Backs the panel's Quit affordance; with
 * minimize-to-tray on window close, this is the deliberate exit path.
 */
export function quitApp(): Promise<void> {
  return invoke<void>("quit_app");
}

// ---------- Event listeners ----------

/**
 * Subscribe to `clippity://tray/opened`. The backend emits once per
 * panel open, after the window is positioned + shown — the panel
 * persists hidden between opens, so this (not React mount) is the cue
 * to refresh recents + reset focus. Returns a sync unsubscribe — return
 * it directly from a `useEffect`.
 */
export function onTrayOpened(handler: () => void): () => void {
  return on<void>(EVENT_NAMES.trayOpened, () => handler());
}
