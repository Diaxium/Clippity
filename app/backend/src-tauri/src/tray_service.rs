//! System-tray icon + frosted quick-action flyout panel.
//!
//! Mirrors the **countdown** pattern (see `countdown_service.rs`): the
//! backend owns a pre-declared, transparent, always-on-top utility
//! window (`tray`, route `index.html#/tray`) — it sizes, positions,
//! shows, and hides the window and emits an event; the React side
//! (`features/tray`) owns everything the user sees and does inside it.
//!
//! `build` constructs the tray icon. Left-click toggles the flyout
//! panel; right-click opens a minimal NATIVE fallback menu (Show ·
//! Settings · Quit) so the core actions are reachable even if the
//! webview panel ever fails to paint. See
//! [ADR 0003](../../docs/decisions/0003-tray-flyout-panel.md).
//!
//! The panel is intentionally NOT a `window_service::PRIMARY_WINDOW`:
//! it coexists with whatever primary window is up (like toast /
//! countdown) instead of participating in the single-primary mutual
//! exclusion. It dismisses on focus loss (`on_panel_blur`) and on Esc
//! (frontend → `hide_tray_panel`). Because it isn't a primary window,
//! the capture pipeline won't hide it for us, so `hide_panel` runs a
//! compositor settle when it actually took the panel off-screen — a
//! tray-initiated capture must not include the panel itself.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

use clippity_infra::events;
use crate::app::state::AppState;
use clippity_domain::dashboard::{DashboardRequest, DashboardView};
use clippity_infra::error::{AppError, AppResult};
use clippity_services::window_service;

/// Flyout size in logical pixels. Fixed — the React layout fits within
/// it (and scrolls if the recents row ever overflows), so there's no
/// resize-on-show dance. Tauri converts to physical px at the DPI seam.
const PANEL_W_LOGICAL: f64 = 340.0;
const PANEL_H_LOGICAL: f64 = 464.0;

/// Gap (logical px) between the panel and the work-area edges so the
/// card floats just inside the corner rather than flush to it.
const PANEL_MARGIN_LOGICAL: f64 = 8.0;

/// How long after a focus-loss auto-hide a tray left-click is treated
/// as the *dismiss* gesture instead of a re-open. Clicking the tray
/// icon while the panel is open blurs the panel first (→ `on_panel_blur`
/// hides it) and only then delivers the click; without this guard the
/// click would see "not visible" and immediately re-open, flickering
/// the panel. 220 ms comfortably covers the blur→click ordering jitter
/// while staying far below a deliberate "open, glance away, click
/// again" interval.
const REOPEN_GUARD: Duration = Duration::from_millis(220);

/// Stable window label for the flyout. Kept in lock-step with
/// `tauri.conf.json`, `capabilities/default.json`, and the frontend's
/// `config/constants.ts`.
const PANEL_LABEL: &str = "tray";

#[derive(Default)]
pub struct TrayService {
    /// Instant the panel was last hidden by losing focus. `toggle_panel`
    /// consults it to tell a dismiss-click apart from a fresh open.
    last_auto_hide: Mutex<Option<Instant>>,
}

impl TrayService {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build the tray icon + its native fallback menu and wire the
    /// click/menu handlers. Called once from `lib.rs::run`'s `setup`.
    /// The returned `TrayIcon` is retained by the app via its id, so we
    /// can drop it here (matches the legacy + Tauri-example pattern).
    pub fn build(&self, app: &AppHandle) -> AppResult<()> {
        let show = MenuItem::with_id(app, "tray_show", "Show Clippity", true, None::<&str>)?;
        let settings = MenuItem::with_id(app, "tray_settings", "Settings…", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "tray_quit", "Quit Clippity", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &settings, &sep, &quit])?;

        let mut builder = TrayIconBuilder::with_id("clippity-tray")
            .tooltip("Clippity")
            .menu(&menu)
            // Left-click is reserved for the flyout; the native menu is
            // the right-click fallback only.
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "tray_show" => {
                    window_service::focus_primary_window(app, "capture");
                }
                "tray_settings" => open_dashboard_settings(app),
                "tray_quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    app.state::<AppState>().tray_service.toggle_panel(app);
                }
            });

        // The bundled app icon is always present; a theme-matched
        // monochrome glyph (legacy had one for light taskbars) is a
        // future polish, tracked in REBUILD.md.
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    }

    /// Show the panel if hidden, hide it if shown. Invoked from the
    /// tray icon's left-click. Runs on the main (event-loop) thread, so
    /// the window ops are safe to call inline.
    pub fn toggle_panel(&self, app: &AppHandle) {
        // Blur-then-click guard (see `REOPEN_GUARD`): if an auto-hide
        // just fired, this click is the gesture that caused it — consume
        // the marker and stay hidden instead of re-opening.
        if let Ok(mut slot) = self.last_auto_hide.lock() {
            if let Some(hidden_at) = slot.take() {
                if hidden_at.elapsed() < REOPEN_GUARD {
                    return;
                }
            }
        }

        let visible = app
            .get_webview_window(PANEL_LABEL)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        if visible {
            let _ = self.hide_panel(app);
        } else if let Err(e) = self.show_panel(app) {
            tracing::warn!("tray: could not show panel: {e}");
        }
    }

    /// Position the panel inside the work-area's bottom-right corner
    /// (above a standard bottom taskbar, near the tray), reveal it, take
    /// focus, and emit `clippity://tray/opened` so the frontend refreshes
    /// its recents + resets focus.
    pub fn show_panel(&self, app: &AppHandle) -> AppResult<()> {
        let panel = app
            .get_webview_window(PANEL_LABEL)
            .ok_or_else(|| AppError::Tray("tray window missing from tauri config".into()))?;
        reposition_panel(app, &panel)?;
        panel.set_always_on_top(true).map_err(AppError::from)?;
        panel.show().map_err(AppError::from)?;
        panel.set_focus().map_err(AppError::from)?;
        events::emit(app, events::names::TRAY_OPENED, ())?;
        Ok(())
    }

    /// Hide the panel. Called explicitly by the frontend after an action
    /// (or Esc) via `hide_tray_panel`. If the panel was actually on
    /// screen, settle the compositor so a capture started immediately
    /// after can't catch the panel mid-fade — it isn't a PRIMARY_WINDOW,
    /// so the capture pipeline won't hide/settle it for us.
    pub fn hide_panel(&self, app: &AppHandle) -> AppResult<()> {
        if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
            let was_visible = panel.is_visible().unwrap_or(false);
            panel.hide().map_err(AppError::from)?;
            if was_visible {
                window_service::sleep_compositor_unpaint(window_service::CompositorWait::Capture);
            }
        }
        Ok(())
    }

    /// Auto-dismiss on focus loss. Records the instant (so `toggle_panel`
    /// can suppress the immediate re-open) and hides. Wired from
    /// `lib.rs`'s `on_window_event` for `WindowEvent::Focused(false)` on
    /// the `tray` window. No compositor settle here — a blur dismiss
    /// never precedes a capture.
    pub fn on_panel_blur(&self, app: &AppHandle) {
        if let Ok(mut slot) = self.last_auto_hide.lock() {
            *slot = Some(Instant::now());
        }
        if let Some(panel) = app.get_webview_window(PANEL_LABEL) {
            let _ = panel.hide();
        }
    }
}

/// Native-menu "Settings…" → the established dashboard handoff: stash
/// the pending view (race-free for the cold-show case), focus the main
/// window, and emit the runtime switch event for the already-shown
/// case. Mirrors `commands::request_dashboard_view` without the IPC hop.
fn open_dashboard_settings(app: &AppHandle) {
    let request = DashboardRequest {
        view: DashboardView::Settings,
        capture_id: None,
    };
    if let Ok(mut slot) = app.state::<AppState>().pending_dashboard_view.lock() {
        *slot = Some(request.clone());
    }
    window_service::focus_primary_window(app, "main");
    let _ = events::emit(app, events::names::DASHBOARD_VIEW, request);
}

/// Resolve the target work area and place the panel in its bottom-right
/// corner. On Windows we use the cursor monitor's work area (the monitor
/// the user just clicked the tray on); cross-platform we fall back to
/// the primary monitor's full bounds. Mirrors `countdown_service`'s
/// monitor-resolution split.
fn reposition_panel(app: &AppHandle, panel: &tauri::WebviewWindow) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        if let Some((wx, wy, ww, wh)) =
            clippity_platform::windows::monitor::cursor_monitor_work_area()
        {
            return place_bottom_right(panel, wx, wy, ww, wh);
        }
    }

    if let Ok(Some(monitor)) = app.primary_monitor() {
        let pos = *monitor.position();
        let size = *monitor.size();
        return place_bottom_right(panel, pos.x, pos.y, size.width, size.height);
    }
    Ok(())
}

/// Size the panel and anchor it inside the bottom-right of the supplied
/// work-area rect (physical px). Clamps the origin so a small or
/// oddly-positioned work area can never push the panel off-screen.
fn place_bottom_right(
    panel: &tauri::WebviewWindow,
    wx: i32,
    wy: i32,
    ww: u32,
    wh: u32,
) -> AppResult<()> {
    let scale = panel.scale_factor().unwrap_or(1.0);
    let w = (PANEL_W_LOGICAL * scale).round() as u32;
    let h = (PANEL_H_LOGICAL * scale).round() as u32;
    let margin = (PANEL_MARGIN_LOGICAL * scale).round() as i32;

    panel
        .set_size(PhysicalSize::new(w, h))
        .map_err(AppError::from)?;

    let x = (wx + ww as i32 - w as i32 - margin).max(wx);
    let y = (wy + wh as i32 - h as i32 - margin).max(wy);
    panel
        .set_position(PhysicalPosition::new(x, y))
        .map_err(AppError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_constructs() {
        let _ = TrayService::new();
    }

    // The Tauri-touching paths (build / show / hide / blur + geometry)
    // are covered by the manual gate — there's no portable way to spin
    // up a real tray icon or `WebviewWindow` inside a unit test, matching
    // the note in `countdown_service`.
}
