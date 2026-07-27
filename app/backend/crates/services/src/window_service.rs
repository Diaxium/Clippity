//! Shared window-lifecycle primitives for capture-style flows.
//!
//! Capture and overlay both need to hide-then-grab-then-restore a
//! "primary" window before taking a screenshot. The capture port
//! kept these helpers inline (`hide_capture_window_briefly`,
//! `restore_capture_window`) with a tech-debt entry pointing here
//! for the overlay's eventual second consumer — this file is that
//! promotion.
//!
//! Both consumers funnel through `hide_primary_windows(keep_label)`
//! / `restore_window(label)` and the named compositor-unpaint sleep
//! in `infra::config`. No service state — pure orchestration.

use tauri::{AppHandle, Manager};

use clippity_infra::config;

/// Mutually-exclusive "primary" windows — only one of these is
/// allowed to be visible at a time during a capture. Toast (post-
/// capture notification) and countdown (pre-capture timer) are
/// intentionally excluded; they coexist with whichever primary
/// window is active.
pub const PRIMARY_WINDOWS: &[&str] = &["capture", "main", "overlay"];

/// Hide every primary window except `keep`. Returns how many windows
/// were actually hidden, so callers can decide how much compositor
/// unpaint time they need before grabbing the screen.
pub fn hide_primary_windows(app: &AppHandle, keep: &str) -> usize {
    let mut hidden_count = 0;
    for label in PRIMARY_WINDOWS {
        if *label == keep {
            continue;
        }
        if let Some(win) = app.get_webview_window(label) {
            if win.is_visible().unwrap_or(false) {
                let _ = win.hide();
                hidden_count += 1;
            }
        }
    }
    hidden_count
}

/// Show + focus a window by label. Idempotent; silent no-op if the
/// label doesn't resolve.
pub fn restore_window(app: &AppHandle, label: &str) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Which `PRIMARY_WINDOWS` label is currently visible. Returns the
/// first match (in declaration order). Used by the overlay to
/// remember which window to restore after a capture, and by the
/// dashboard / capture mutual-exclusion enforcement to know whether
/// a "show" already had nothing to hide.
pub fn current_visible_primary(app: &AppHandle) -> Option<&'static str> {
    for label in PRIMARY_WINDOWS {
        if let Some(win) = app.get_webview_window(label) {
            if win.is_visible().unwrap_or(false) {
                return Some(*label);
            }
        }
    }
    None
}

/// Enforce the single-primary-window invariant: hide every primary
/// window EXCEPT `label`, then show + focus `label`. Use this from
/// `show_capture_window` and `request_dashboard_view` (which both
/// represent "the user wants this primary window forward").
///
/// Returns true when a primary window was actually swapped (the
/// caller can use this for analytics / logging if needed).
pub fn focus_primary_window(app: &AppHandle, label: &str) -> bool {
    let was_visible = current_visible_primary(app);
    hide_primary_windows(app, label);
    restore_window(app, label);
    was_visible != Some(label)
}

/// Which compositor-unpaint sleep the caller wants. Sleeps run on
/// the calling thread — these are `std::thread::sleep`, not async,
/// because Tauri commands already run on a blocking executor and
/// switching to `tokio::time::sleep` here would add an executor
/// hop without changing behaviour. If profiling shows this hurts
/// IPC throughput, the right fix is an event-driven "compositor
/// settled" signal, not a sleep flavour swap — tracked in
/// REBUILD.md.
/// The capture path's fixed unpaint sleep, used by the live-regrab
/// fallbacks (a cached snapshot missing or failed). The overlay open path
/// no longer uses a fixed sleep at all — see [`settle_after_hide`], which
/// waits on the actual hide instead of guessing at it.
#[derive(Clone, Copy, Debug)]
pub enum CompositorWait {
    /// Capture window only is hidden; ~120 ms.
    Capture,
}

pub fn sleep_compositor_unpaint(kind: CompositorWait) {
    let dur = match kind {
        CompositorWait::Capture => config::capture_unpaint_sleep(),
    };
    std::thread::sleep(dur);
}

/// Block until DWM has presented `cycles` composition frames. Pair
/// with [`sleep_compositor_unpaint`] before a screen capture that
/// must not include a window we just hid — Tauri's `.hide()` posts a
/// message to the window thread, and a time-based sleep alone can't
/// guarantee DWM has actually swapped out the buffer by the time we
/// grab it. Two flushes is usually enough; the sleep handles the
/// pre-flush hide-message processing window.
///
/// No-op on non-Windows platforms (the legacy time-based sleep was
/// already sufficient on macOS / Linux where the compositor model
/// differs).
pub fn wait_compositor_compose(cycles: u32) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Graphics::Dwm::DwmFlush;
        for _ in 0..cycles {
            unsafe {
                let _ = DwmFlush();
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = cycles;
    }
}

/// Wait until windows just hidden by [`hide_primary_windows`] are gone
/// from the composited desktop — the guard in front of any snapshot that
/// must not contain our own chrome.
///
/// Two unknowns, addressed in order by two mechanisms:
///
/// 1. **The hide is processed.** `.hide()` runs `ShowWindow(SW_HIDE)`,
///    which the window's own thread must service before `WS_VISIBLE`
///    clears. This is the step that made a fixed sleep fragile — too
///    short and the flush below runs while the window is still up,
///    baking it into the shot. So instead of guessing, poll
///    `is_visible()` (a plain `IsWindowVisible`, safe from this thread)
///    until every primary is down. The poll exits the instant the hide
///    lands — a frame or two, typically — rather than after a
///    worst-case sleep, and is bounded so a wedged pump can't hang the
///    capture.
/// 2. **The recomposition.** Once the window is down, a short floor plus
///    `DwmFlush` gives DWM a clean frame to present. Crucially this now
///    runs *after* (1), so the flush can't present a frame that still
///    contains the window.
///
/// This replaces a flat 260 ms sleep on the overlay path, which had to
/// assume the worst about (1) — a step (1) can simply observe.
pub fn settle_after_hide(app: &AppHandle) {
    wait_primaries_hidden(app);
    std::thread::sleep(config::compositor_unpaint_floor());
    wait_compositor_compose(config::COMPOSITOR_SETTLE_FLUSHES);
}

/// Spin (with short yields) until no primary window reports visible, or
/// the hide-timeout elapses. The deterministic half of
/// [`settle_after_hide`]; see its doc for why `IsWindowVisible` is the
/// signal.
///
/// At the point this runs during an overlay/capture open, every primary
/// has been hidden and the overlay isn't shown yet, so "no primary
/// visible" is exactly "our chrome is gone". A timeout hit is logged and
/// falls through — a slightly-early grab beats a hung capture.
fn wait_primaries_hidden(app: &AppHandle) {
    if !spin_until(config::compositor_hide_timeout(), || {
        current_visible_primary(app).is_none()
    }) {
        tracing::warn!(
            "a primary window was still visible after the hide timeout; \
             grabbing anyway (snapshot may briefly show chrome)"
        );
    }
}

/// Poll `done` every 2 ms until it returns true or `timeout` elapses.
/// Returns whether `done` was observed true (vs. timed out). The bounded
/// half of [`settle_after_hide`], pulled out of the `AppHandle` so its
/// termination guarantee can be tested without a live window.
fn spin_until(timeout: std::time::Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if done() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

#[cfg(test)]
mod tests {
    use super::spin_until;
    use std::cell::Cell;
    use std::time::{Duration, Instant};

    #[test]
    fn spin_until_returns_as_soon_as_the_condition_holds() {
        let calls = Cell::new(0);
        // False, false, then true — exits on the third poll, well under
        // the timeout.
        let ok = spin_until(Duration::from_secs(5), || {
            calls.set(calls.get() + 1);
            calls.get() >= 3
        });
        assert!(ok);
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn spin_until_gives_up_at_the_timeout_rather_than_hanging() {
        // A wedged pump: the condition never holds. The capture must not
        // hang on it — bounded, and it reports the give-up.
        let start = Instant::now();
        let ok = spin_until(Duration::from_millis(30), || false);
        assert!(!ok);
        assert!(start.elapsed() < Duration::from_secs(2), "must not hang");
    }

    #[test]
    fn spin_until_checks_before_sleeping() {
        // Already-satisfied: returns true on the first poll without ever
        // sleeping, so a fast hide costs nothing.
        let ok = spin_until(Duration::from_secs(5), || true);
        assert!(ok);
    }
}

/// Convenience helper for the capture path: hide the capture window
/// only if it's visible, sleep the capture-flavoured unpaint, then
/// return. Mirrors the legacy `hide_capture_window_briefly` shape
/// so the migration from inline helpers is a one-line replacement.
pub fn hide_capture_briefly(app: &AppHandle) {
    if hide_primary_windows(app, "overlay") > 0 {
        sleep_compositor_unpaint(CompositorWait::Capture);
    }
}
