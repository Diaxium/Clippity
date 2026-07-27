//! Toast orchestration — show / hide / resize the small floating
//! notification window pinned to a corner of the cursor's monitor.
//!
//! **Armed variants**: `Error` (MVP), `Color` (ADR 0005), `Palette`
//! (ADR 0006), `Text` (ADR 0007), `Recording` (Scrolling-Window port,
//! ADR 0008), and `Clipboard` (Clipboard custom mode, ADR 0009) route
//! through `show` (`Clipboard` + `Text` + `Recording` are sticky —
//! dismissed via the toast's ×). The remaining reserved variants reject
//! with `AppError::Unsupported` at the service boundary — same shape as
//! `OverlayMode::Region` did during the overlay port — and arm as their
//! owning ports land.
//!
//! **Settings dependency**: the corner + per-kind durations are
//! sourced from `ToastDefaults` injected at construction. When
//! settings port #6 lands, swap to a `SettingsAccessor` trait that
//! reads live user overrides; the service shape doesn't change.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize};

use clippity_infra::events;
use clippity_domain::toast::{self, ToastPayload};
use clippity_infra::error::{AppError, AppResult};
use crate::settings_service::ToastSettingsSource;

/// Breathing room between the toast and the work-area edge, in
/// physical pixels. Matches legacy.
const ANCHOR_GAP_PX: i32 = 12;

pub struct ToastService {
    settings: Arc<dyn ToastSettingsSource>,
}

impl ToastService {
    pub fn new(settings: Arc<dyn ToastSettingsSource>) -> Self {
        Self { settings }
    }

    /// Show the toast with `payload`. Reposition first, then reveal,
    /// then emit `clippity://toast/show` carrying the payload + the
    /// per-kind duration.
    ///
    /// Non-MVP variants reject with `AppError::Unsupported` so a
    /// runaway emit (e.g. a future port emitting before its body is
    /// implemented) fails loudly instead of rendering the fallback
    /// `UnknownKindBody`.
    pub fn show(&self, app: &AppHandle, payload: ToastPayload) -> AppResult<()> {
        // Error (MVP) + Clipboard / Color / Palette / Text (custom-mode
        // ports) + Recording are armed; the other reserved variants still
        // reject so a runaway emit fails loudly.
        if !matches!(
            payload,
            ToastPayload::Error { .. }
                | ToastPayload::Clipboard { .. }
                | ToastPayload::Color { .. }
                | ToastPayload::Palette { .. }
                | ToastPayload::Text { .. }
                | ToastPayload::Recording { .. }
                | ToastPayload::Recorder { .. }
        ) {
            return Err(AppError::Unsupported("toast variant not yet ported"));
        }
        self.show_internal(app, payload)
    }

    /// Convenience: build `ToastPayload::Error` from a message and
    /// route it through `show`. Used by backend-originated error
    /// surfaces (capture / overlay command failures).
    pub fn show_error(&self, app: &AppHandle, message: impl Into<String>) -> AppResult<()> {
        self.show(
            app,
            ToastPayload::Error {
                message: message.into(),
            },
        )
    }

    /// Hide the toast window. Also emits `clippity://toast/hide` so
    /// consumers can reset state when the backend hides for non-
    /// frontend reasons. The common path is the frontend's
    /// post-animation `hideToast()` IPC call — that path is also
    /// idempotent (frontend already cleared its state).
    pub fn hide(&self, app: &AppHandle) -> AppResult<()> {
        if let Some(toast) = app.get_webview_window("toast") {
            toast.hide().map_err(AppError::from)?;
        }
        events::emit(app, events::names::TOAST_HIDE, ())?;
        Ok(())
    }

    /// Toggle `WDA_EXCLUDEFROMCAPTURE` on the toast window so the
    /// scroll-recording HUD never lands in a captured frame (ADR 0008).
    /// No-op off Windows / when the window isn't up yet.
    ///
    /// **Only ever called with `true`.** The session-wide capture shield
    /// (`capture_shield::shield_windows`, applied to every window at
    /// startup) has owned this flag since it landed, so the HUD's calls
    /// are re-assertions of a state that is already set. Passing `false`
    /// would not restore a previous state — it sets `WDA_NONE`, silently
    /// dropping the toast out of the shield for the rest of the session.
    /// The `excluded` parameter is kept because the flag is genuinely
    /// two-valued at the platform layer.
    pub fn set_capture_excluded(&self, app: &AppHandle, excluded: bool) {
        #[cfg(target_os = "windows")]
        if let Some(toast) = app.get_webview_window("toast") {
            clippity_platform::windows::chrome::set_capture_excluded(&toast, excluded);
        }
        #[cfg(not(target_os = "windows"))]
        let _ = (app, excluded);
    }

    /// Resize the toast window to the supplied logical dimensions and
    /// re-anchor it. Frontend's `useToastResize` calls this when the
    /// measured content height changes; backend-side clamp defends
    /// against runaway measurements.
    pub fn resize(&self, app: &AppHandle, width: f64, height: f64) -> AppResult<()> {
        let toast = app
            .get_webview_window("toast")
            .ok_or_else(|| AppError::Toast("toast window missing from tauri config".into()))?;
        let (w, h) = toast::clamp_size(width, height);
        toast
            .set_size(tauri::LogicalSize::new(w, h))
            .map_err(AppError::from)?;
        // Re-anchor using the *target* physical size derived from the
        // scale factor — NOT a read-back of `outer_size()`. On Windows
        // that read races the just-issued `set_size` and returns the
        // pre-resize height, so a growing toast (the recording HUD gaining
        // its preview) gets anchored as if still short and its bottom —
        // the Stop/Discard controls — slides under the taskbar. Anchoring
        // upward from a bottom corner needs the real new height.
        let scale = toast.scale_factor().unwrap_or(1.0);
        let outer = PhysicalSize::new((w * scale).round() as u32, (h * scale).round() as u32);
        self.reposition(app, outer)?;
        Ok(())
    }

    fn show_internal(&self, app: &AppHandle, payload: ToastPayload) -> AppResult<()> {
        let toast = app
            .get_webview_window("toast")
            .ok_or_else(|| AppError::Toast("toast window missing from tauri config".into()))?;
        let outer = toast.outer_size().map_err(AppError::from)?;
        self.reposition(app, outer)?;
        toast.set_always_on_top(true).map_err(AppError::from)?;
        toast.show().map_err(AppError::from)?;

        let live = self.settings.toast_settings();
        let duration_ms = live.durations.for_payload(&payload);
        // The window is already on screen at this point, so a failed emit
        // would strand it visible with nothing in it — and the frontend,
        // never having received a payload, has no toast to dismiss and so
        // no path that hides it again. Put it back before reporting the
        // failure; the caller's error is then the only symptom.
        if let Err(e) = events::emit(
            app,
            events::names::TOAST_SHOW,
            ToastShowEvent {
                payload,
                duration_ms,
            },
        ) {
            let _ = toast.hide();
            return Err(e);
        }
        Ok(())
    }

    /// Position the toast at `defaults.corner` of the cursor's
    /// monitor's work area (Windows) or the primary monitor
    /// (cross-platform fallback). Silent no-op if both lookups fail
    /// — the toast still shows, just at its last position.
    fn reposition(&self, app: &AppHandle, outer: PhysicalSize<u32>) -> AppResult<()> {
        let toast = app
            .get_webview_window("toast")
            .ok_or_else(|| AppError::Toast("toast window missing from tauri config".into()))?;
        let corner = self.settings.toast_settings().corner;

        #[cfg(target_os = "windows")]
        {
            if let Some((wx, wy, ww, wh)) =
                clippity_platform::windows::monitor::cursor_monitor_work_area()
            {
                let (x, y) = toast::anchor_to_corner(
                    (wx, wy, ww as i32, wh as i32),
                    (outer.width, outer.height),
                    corner,
                    ANCHOR_GAP_PX,
                );
                toast
                    .set_position(PhysicalPosition::new(x, y))
                    .map_err(AppError::from)?;
                return Ok(());
            }
        }

        // Non-Windows / Win32 lookup failed — anchor against the
        // primary monitor with a DPI-aware gap.
        if let Ok(Some(monitor)) = app.primary_monitor() {
            let pos = *monitor.position();
            let size = *monitor.size();
            let pad = (ANCHOR_GAP_PX as f64 * monitor.scale_factor()).round() as i32;
            let work = (pos.x, pos.y, size.width as i32, size.height as i32);
            let (x, y) = toast::anchor_to_corner(work, (outer.width, outer.height), corner, pad);
            toast
                .set_position(PhysicalPosition::new(x, y))
                .map_err(AppError::from)?;
        }
        Ok(())
    }
}

/// Wire shape of `clippity://toast/show`. Flattens the discriminated
/// `ToastPayload` into the outer object so the frontend sees a single
/// JSON object `{ kind, …payload-fields, durationMs }`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ToastShowEvent {
    #[serde(flatten)]
    payload: ToastPayload,
    duration_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::toast::ToastDefaults;
    use crate::settings_service::StaticToastSettings;

    #[test]
    fn service_constructs() {
        let settings: Arc<dyn ToastSettingsSource> =
            Arc::new(StaticToastSettings(ToastDefaults::defaults()));
        let svc = ToastService::new(settings);
        // Touch a field through the public API surface to prove
        // construction succeeded.
        assert_eq!(
            svc.settings.toast_settings().durations.error,
            ToastDefaults::defaults().durations.error
        );
    }

    #[test]
    fn show_show_event_serde_shape() {
        // Build the wire event without going through Tauri so the
        // flatten + camelCase shape is verifiable in a unit test.
        let evt = ToastShowEvent {
            payload: ToastPayload::Error {
                message: "boom".into(),
            },
            duration_ms: 6000,
        };
        let s = serde_json::to_string(&evt).unwrap();
        assert!(s.contains(r#""kind":"error""#), "got {s}");
        assert!(s.contains(r#""message":"boom""#), "got {s}");
        assert!(s.contains(r#""durationMs":6000"#), "got {s}");
    }
}
