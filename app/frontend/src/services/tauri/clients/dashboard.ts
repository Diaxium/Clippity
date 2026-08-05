/**
 * Dashboard cross-window handoff client.
 *
 * The "dashboard" is the main window's internal-routing concept —
 * Library / Editor / Settings are views rendered inside one window.
 * Other windows (capture settings links, library items, future toast
 * actions) call `openDashboard(view, captureId)` to focus the main
 * window and switch its view.
 *
 * Race avoidance: when the main window is shown for the first time,
 * its `listen` registers AFTER `emit` fires, so we'd lose the event.
 * Backend `pending_dashboard_view` stash solves it — the dashboard
 * drains it on mount via `consumePendingDashboardView`. We still
 * emit the event for the already-shown case so the dashboard switches
 * view immediately when the user clicks Open while it's open.
 *
 * The wire-format types live in `@clippity/shared` and are re-exported here.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import type { DashboardView, DashboardRequest } from "@clippity/shared";

export type { DashboardView, DashboardRequest } from "@clippity/shared";

// ---------- IPC wrappers ----------

/**
 * Stash a pending view + (optional) editor capture id, hide every
 * other primary window, show + focus the dashboard window, and emit
 * `clippity://dashboard/view` for the already-shown case. Backend
 * enforces the single-primary-window invariant; the dashboard
 * frontend reads the stash on mount via
 * `consumePendingDashboardView` (race-free for the cold-show case).
 *
 * Use `openDashboard` (sugar below) at call sites; this raw wrapper
 * is exposed for tests + advanced callers.
 */
export function requestDashboardView(
  view: DashboardView,
  captureId: string | null
): Promise<void> {
  return invoke<void, { view: DashboardView; captureId: string | null }>(
    "request_dashboard_view",
    { view, captureId }
  );
}

export function consumePendingDashboardView(): Promise<DashboardRequest | null> {
  return invoke<DashboardRequest | null>("consume_pending_dashboard_view");
}

// ---------- Cross-window helper ----------

/**
 * Focus the dashboard window and render `view`. When `view === "editor"`,
 * pass the `captureId` to load. Used by capture-window settings links and
 * the library card's "Open in editor" button.
 *
 * Thin wrapper around `requestDashboardView` — the backend does the
 * stash + hide-other-primaries + show + emit work atomically.
 */
export async function openDashboard(
  view: DashboardView,
  captureId: string | null = null
): Promise<void> {
  try {
    await requestDashboardView(view, captureId);
  } catch {
    /* not in Tauri context */
  }
}

/**
 * Subscribe to the dashboard-view event. Returns a sync unsubscribe.
 * The dashboard listens for runtime view changes (after first paint);
 * the initial paint uses `consumePendingDashboardView` to drain.
 */
export function onDashboardView(
  handler: (payload: DashboardRequest) => void
): () => void {
  return on<DashboardRequest>(EVENT_NAMES.dashboardView, handler);
}
