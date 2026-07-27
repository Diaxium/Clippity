//! Countdown HUD orchestration.
//!
//! `start` resolves the cursor monitor's work area (Windows) or the
//! primary monitor (cross-platform fallback), resizes the pre-declared
//! countdown window into a wide strip pinned at the work-area's bottom
//! edge (i.e. flush against the top of the OS taskbar), hides the
//! caller's primary window so it isn't in the deferred shot, shows
//! the countdown strip, and emits `clippity://countdown/start`.
//!
//! `cancel` hides the strip and restores whichever primary window
//! was visible when `start` ran, then emits `countdown/cancelled`.
//!
//! `finish` hides the strip and emits `countdown/finished` but
//! deliberately does NOT restore the previous primary — the next
//! step (the capture itself) will handle window restoration. Putting
//! the restore here would briefly flash the capture window between
//! "timer hits zero" and "capture pipeline takes over".
//!
//! The strip is intentionally NOT focus-stealing (`focus: false` in
//! `tauri.conf.json`) AND click-through (`set_ignore_cursor_events`)
//! so the user's keyboard focus and mouse both stay with whatever they
//! were doing while the timer ticks down — it behaves like a passive
//! system status indicator, never a dialog (design spec: "do not steal
//! focus", "do not prevent interaction"). Because the window is never
//! focused, it can't receive a keydown; Escape is therefore handled by
//! a GLOBAL shortcut registered while the strip is visible (see
//! `register_escape`) and routed to `cancel` by the plugin handler
//! wired in `lib.rs::run`.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

use clippity_infra::events;
use clippity_domain::countdown::{
    validate_request, CountdownRequest, CountdownStartEvent, COUNTDOWN_HEIGHT_LOGICAL,
};
use clippity_infra::error::{AppError, AppResult};
use crate::window_service;

/// Tracks which primary window (`capture` / `main` / `overlay`) was
/// visible at `start` time so `cancel` can put the user back where
/// they were. `None` while no countdown is active.
#[derive(Default)]
struct CountdownState {
    previous_primary: Option<String>,
}

pub struct CountdownService {
    state: Mutex<CountdownState>,
}

impl CountdownService {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(CountdownState::default()),
        }
    }

    /// Position the strip across the cursor monitor's work area's
    /// bottom edge, stash + hide the currently visible primary so it
    /// isn't in the deferred shot, show the strip, emit start. The
    /// frontend's `useCountdown` listener picks the seconds out of
    /// the payload and drives the per-second tick locally.
    pub fn start(&self, app: &AppHandle, request: CountdownRequest) -> AppResult<()> {
        let request = validate_request(request).map_err(|e| AppError::Countdown(e.to_string()))?;

        let countdown = app.get_webview_window("countdown").ok_or_else(|| {
            AppError::Countdown("countdown window missing from tauri config".into())
        })?;

        reposition_strip(app, &countdown)?;

        // Remember which primary window was visible so cancel can
        // restore it. Doing this BEFORE hide_primary_windows wipes
        // the visible state.
        let previous = window_service::current_visible_primary(app).map(str::to_string);
        if let Ok(mut s) = self.state.lock() {
            s.previous_primary = previous;
        }
        // Hide every primary (`countdown` isn't in PRIMARY_WINDOWS so
        // the strip itself is unaffected). The capture-workflow delay
        // branch only triggers from the capture window today, but a
        // future overlay-side delay path (e.g. delayed Region) would
        // reuse this same hide-and-stash without changes.
        window_service::hide_primary_windows(app, "countdown");

        countdown.set_always_on_top(true).map_err(AppError::from)?;
        // Pure status overlay: never intercept pointer events so the
        // user can keep clicking the desktop / apps / taskbar behind
        // the strip while it counts down. Best-effort — a strip that
        // can't go click-through is still preferable to no countdown.
        let _ = countdown.set_ignore_cursor_events(true);
        countdown.show().map_err(AppError::from)?;

        // Register the global Escape accelerator so the unfocused,
        // click-through strip can still be cancelled from the keyboard.
        // Removed again in `cancel` / `finish`.
        register_escape(app);

        events::emit(
            app,
            events::names::COUNTDOWN_START,
            CountdownStartEvent {
                seconds: request.seconds,
            },
        )?;
        Ok(())
    }

    /// Hide the strip, restore the previously visible primary window,
    /// emit `countdown/cancelled`. Used by the frontend's Esc handler.
    /// Idempotent: a second `cancel` after the strip is already hidden
    /// still fires the event so any racing listener sees the cancel
    /// (the previous-primary slot is empty by then so no restore is
    /// attempted).
    pub fn cancel(&self, app: &AppHandle) -> AppResult<()> {
        unregister_escape(app);
        if let Some(countdown) = app.get_webview_window("countdown") {
            countdown.hide().map_err(AppError::from)?;
        }
        let previous = self
            .state
            .lock()
            .ok()
            .and_then(|mut s| s.previous_primary.take());
        if let Some(label) = previous {
            window_service::restore_window(app, &label);
        }
        events::emit(app, events::names::COUNTDOWN_CANCELLED, ())?;
        Ok(())
    }

    /// Hide the strip and emit `countdown/finished`. The previous-
    /// primary slot is cleared but the window is NOT shown — the
    /// caller (capture-workflow delay branch) takes over from here
    /// and will perform the actual capture, which handles its own
    /// hide/restore cycle. Avoids a brief flash of the capture window
    /// between countdown end and capture begin.
    pub fn finish(&self, app: &AppHandle) -> AppResult<()> {
        unregister_escape(app);
        if let Some(countdown) = app.get_webview_window("countdown") {
            countdown.hide().map_err(AppError::from)?;
        }
        // Drop the stash without restoring — the next operation owns
        // the window pipeline. If the caller turns out to NOT run a
        // capture (defensive), the user's tray icon is the recovery
        // path.
        if let Ok(mut s) = self.state.lock() {
            s.previous_primary = None;
        }
        events::emit(app, events::names::COUNTDOWN_FINISHED, ())?;
        Ok(())
    }
}

/// The global accelerator that cancels an active countdown: plain
/// Escape, no modifiers. Built fresh each call — `Shortcut` equality
/// is by (modifiers, key) so the `lib.rs` handler can match the fired
/// shortcut against an identical value.
fn escape_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

/// Register the global Escape accelerator. Best-effort: registration
/// can fail if another app already holds Escape — the countdown still
/// runs and ticks to completion, the user just can't abort via keyboard
/// in that (rare) case.
fn register_escape(app: &AppHandle) {
    if let Err(e) = app.global_shortcut().register(escape_shortcut()) {
        tracing::warn!("countdown: could not register Esc accelerator: {e}");
    }
}

/// Remove the global Escape accelerator. Best-effort — unregistering a
/// shortcut that was never registered (registration failed at start)
/// returns an error we deliberately ignore so Escape returns to the
/// foreground app the instant the countdown ends.
fn unregister_escape(app: &AppHandle) {
    let _ = app.global_shortcut().unregister(escape_shortcut());
}

impl Default for CountdownService {
    fn default() -> Self {
        Self::new()
    }
}

/// Resize the strip to the work-area's full width (capped at the
/// available width) × `COUNTDOWN_HEIGHT_LOGICAL`, then position it
/// flush against the work-area's bottom edge. On Windows we use the
/// cursor monitor's work area so a multi-monitor user gets the strip
/// over the monitor they're currently looking at; cross-platform we
/// fall back to the primary monitor.
fn reposition_strip(app: &AppHandle, countdown: &tauri::WebviewWindow) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        if let Some((wx, wy, ww, wh)) =
            clippity_platform::windows::monitor::cursor_monitor_work_area()
        {
            apply_strip_geometry(countdown, wx, wy, ww, wh)?;
            return Ok(());
        }
    }

    // Fallback: primary monitor in logical units. We treat the whole
    // monitor as the work area here — without a Win32 work-area query
    // there's no portable way to know where the taskbar is, so the
    // user sees the strip at the very bottom of the monitor instead.
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let pos = *monitor.position();
        let size = *monitor.size();
        apply_strip_geometry(countdown, pos.x, pos.y, size.width, size.height)?;
    }
    Ok(())
}

/// Pure-ish geometry application. `wx`/`wy`/`ww`/`wh` are physical
/// pixels on Windows and logical-but-DPR-equivalent on the fallback
/// path (Tauri auto-converts when we hand it a `PhysicalSize`).
fn apply_strip_geometry(
    countdown: &tauri::WebviewWindow,
    wx: i32,
    wy: i32,
    ww: u32,
    wh: u32,
) -> AppResult<()> {
    let scale = countdown.scale_factor().unwrap_or(1.0);
    let height_px = ((COUNTDOWN_HEIGHT_LOGICAL as f64) * scale).round() as u32;
    let height_px = height_px.min(wh);
    countdown
        .set_size(PhysicalSize::new(ww, height_px))
        .map_err(AppError::from)?;
    let y = wy + wh as i32 - height_px as i32;
    countdown
        .set_position(PhysicalPosition::new(wx, y))
        .map_err(AppError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_constructs() {
        let _ = CountdownService::new();
    }

    // The Tauri-touching paths (start / cancel / finish + geometry
    // helpers) are covered by the manual gate — there's no portable
    // way to spin up a real `WebviewWindow` inside a unit test.
    // Domain-side coverage lives in `domain::countdown::tests`
    // (validate_request + serde round-trips).
}
