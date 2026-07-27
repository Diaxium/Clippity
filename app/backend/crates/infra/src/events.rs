//! Outbound event channel — wraps `tauri::AppHandle::emit` so the rest
//! of the backend doesn't import Tauri types directly.
//!
//! Event names mirror the frontend's `services/tauri/events.ts` and
//! follow `clippity://<domain>/<verb>` to make routing trivial.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

/// Canonical event names. Adding a new event:
/// 1. Add the constant here.
/// 2. Add the matching typed listener in
///    `frontend/src/services/tauri/events.ts`.
pub mod names {
    pub const ONBOARDING_COMPLETE: &str = "clippity://onboarding-complete";
    pub const CAPTURE_FINISHED: &str = "clippity://capture/finished";
    pub const OVERLAY_OPENING: &str = "clippity://overlay/opening";
    pub const OVERLAY_SHOWN: &str = "clippity://overlay/shown";
    /// Fired by the background loupe-encode thread once the cached
    /// snapshot data URI is ready for the frontend to fetch. Decoupled
    /// from `OVERLAY_SHOWN` so the overlay UI doesn't wait on the
    /// (relatively slow) PNG-encode step before becoming interactive.
    pub const OVERLAY_SNAPSHOT_READY: &str = "clippity://overlay/snapshot-ready";
    pub const OVERLAY_TOGGLES: &str = "clippity://overlay/toggles";
    pub const TOAST_SHOW: &str = "clippity://toast/show";
    pub const TOAST_HIDE: &str = "clippity://toast/hide";
    /// Emitted by capture / overlay / library services after any
    /// filesystem change in the captures directory. Listeners
    /// (LibraryLayout in the capture window) refresh on receipt.
    /// Empty payload — this is a "go refetch" notification.
    pub const LIBRARY_UPDATED: &str = "clippity://library/updated";
    /// Emitted after any change to the collections document — create,
    /// rename, delete, membership, reorder. Separate from
    /// `LIBRARY_UPDATED` because the two answer different questions: the
    /// rows a listing returns are unchanged when a capture joins a
    /// collection, so a shared event would make every library view
    /// re-fetch its whole list over an arrangement it doesn't show.
    /// Empty payload — the handler re-fetches.
    pub const COLLECTIONS_UPDATED: &str = "clippity://collections/updated";
    /// Emitted by `request_dashboard_view` so the dashboard switches
    /// views in-flight. The cold-show case still uses the
    /// `pending_dashboard_view` stash + `consume_pending_dashboard_view`
    /// drain because the listener registers AFTER the emit on first
    /// paint.
    pub const DASHBOARD_VIEW: &str = "clippity://dashboard/view";
    pub const SETTINGS_CHANGED: &str = "clippity://settings/changed";
    /// Emitted by `start_countdown` once the strip has been positioned
    /// and shown. Payload: `{ seconds: u32 }` (the starting tick value).
    pub const COUNTDOWN_START: &str = "clippity://countdown/start";
    /// Emitted by `finish_countdown` after the strip's tick reaches
    /// zero. Listeners (capture-workflow delay branch) take this as
    /// the cue to perform the deferred capture. Empty payload.
    pub const COUNTDOWN_FINISHED: &str = "clippity://countdown/finished";
    /// Emitted by `cancel_countdown` after the user aborts via Esc (or
    /// any other future cancel path). Listeners (capture-workflow
    /// delay branch) take this as the cue to bail without capturing.
    /// Empty payload.
    pub const COUNTDOWN_CANCELLED: &str = "clippity://countdown/cancelled";
    /// Emitted by `tray_service` once the flyout panel has been
    /// positioned + shown. Empty payload — the panel's `useTrayPanel`
    /// listener refreshes its recent captures and resets focus to the
    /// first action on receipt (the window persists hidden between
    /// opens, so "on mount" alone wouldn't re-run).
    pub const TRAY_OPENED: &str = "clippity://tray/opened";
    /// Emitted by `presets_service` after any create / update / delete.
    /// Payload: the full `Vec<CapturePreset>`. The tray's Presets
    /// section and the dashboard manager both mirror it.
    pub const PRESETS_CHANGED: &str = "clippity://presets/changed";
    /// Emitted by `scroll_capture_service`'s worker each time a new
    /// (non-duplicate) frame is appended. Payload: `{ frames: u32 }`.
    /// The recording toast HUD updates its count in place.
    pub const RECORDING_TICK: &str = "clippity://recording/tick";
    /// Emitted (throttled) by the worker with a downscaled live stitch.
    /// Payload: `{ dataUri: String }` (base64 PNG). The HUD shows it.
    pub const RECORDING_PREVIEW: &str = "clippity://recording/preview";
    /// Emitted once by the worker when it detects the user reversed scroll
    /// direction (scrolled back the way they came) — the cue that the
    /// capture is complete. The recording HUD responds by committing, the
    /// same path as the Stop & Stitch button. Empty payload.
    pub const RECORDING_AUTO_STOP: &str = "clippity://recording/auto-stop";
    /// Emitted by `recorder_service`'s worker about once a second with
    /// the live `RecorderStatus` (state, elapsed, frames, dropped,
    /// bytes). Drives the recorder HUD's timer and counters.
    ///
    /// Note the `recorder/` prefix rather than `recording/`: those
    /// belong to the scroll stitcher, which is a different session type
    /// producing a still image. See `domain::recorder`.
    pub const RECORDER_TICK: &str = "clippity://recorder/tick";
    /// Emitted once when a recording session ends, whatever the reason.
    /// Payload: `{ reason, result }` — `result` is null for a discard
    /// or a session that produced nothing. The main window's persistent
    /// listener opens the result when `result.preview` is set, mirroring
    /// how `capture/finished` is handled.
    pub const RECORDER_FINISHED: &str = "clippity://recorder/finished";
    /// Emitted by `model_service` after any model status transition
    /// (download started / finished / failed / cancelled, model
    /// removed). Payload: the full `Vec<ModelInfo>` so every window
    /// converges without refetching.
    pub const MODELS_CHANGED: &str = "clippity://models/changed";
    /// Throttled download ticks from a model fetch worker. Payload:
    /// `{ id, downloaded, total }` (bytes). Drives the Models settings
    /// page progress bar between `models/changed` transitions.
    pub const MODELS_PROGRESS: &str = "clippity://models/progress";
}

/// Label of the toast / recording-HUD window, the sole consumer of the
/// high-frequency recording events.
pub const TOAST_WINDOW: &str = "toast";

/// Where an outbound event should be delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventTarget {
    /// Deliver to every open window (Tauri's default `emit` behaviour).
    Broadcast,
    /// Deliver only to the window carrying this label.
    Window(&'static str),
}

/// Decide where an event should be delivered.
///
/// Most events broadcast: any window might be listening, and they fire
/// at human speed (a setting changed, a capture finished). The recording
/// HUD's tick/preview/auto-stop are the exception — they fire several
/// times a second for the whole duration of a scroll capture, and only
/// the toast window ever listens (see `RecordingToastBody`). Broadcasting
/// them wakes the other five always-alive WebViews on every frame to
/// deserialize a payload they immediately discard — including a
/// base64-encoded PNG for each preview tick. Scoping them to the toast
/// window (P1 in the performance roadmap) removes that per-frame wake-up.
///
/// Kept as a pure function so the routing policy is unit-testable without
/// a Tauri runtime.
pub fn target_for(event: &str) -> EventTarget {
    use names::{RECORDER_TICK, RECORDING_AUTO_STOP, RECORDING_PREVIEW, RECORDING_TICK};
    match event {
        // The recorder's tick is the same shape of problem as the
        // stitcher's: a once-a-second payload for the whole length of a
        // recording that only the HUD reads.
        RECORDING_TICK | RECORDING_PREVIEW | RECORDING_AUTO_STOP | RECORDER_TICK => {
            EventTarget::Window(TOAST_WINDOW)
        }
        // RECORDER_FINISHED deliberately broadcasts: the library
        // refreshes on it and the main window may open the result.
        _ => EventTarget::Broadcast,
    }
}

pub fn emit<P: Serialize + Clone>(app: &AppHandle, event: &str, payload: P) -> AppResult<()> {
    let result = match target_for(event) {
        EventTarget::Broadcast => app.emit(event, payload),
        EventTarget::Window(label) => app.emit_to(label, event, payload),
    };
    result.map_err(|e| {
        // Most call sites emit best-effort (`let _ = emit(...)`), so
        // without this a failed emit — a window that never gets its
        // update — would leave no trace at all. Logged here once,
        // centrally, rather than at every (mostly silent) call site.
        tracing::warn!(event, error = %e, "event emit failed");
        AppError::from(e)
    })
}

#[cfg(test)]
mod tests {
    use super::{names, target_for, EventTarget, TOAST_WINDOW};

    #[test]
    fn recording_events_scope_to_the_toast_window() {
        for event in [
            names::RECORDING_TICK,
            names::RECORDING_PREVIEW,
            names::RECORDING_AUTO_STOP,
            names::RECORDER_TICK,
        ] {
            assert_eq!(
                target_for(event),
                EventTarget::Window(TOAST_WINDOW),
                "{event} must be delivered only to the toast window"
            );
        }
    }

    #[test]
    fn other_events_broadcast() {
        for event in [
            names::CAPTURE_FINISHED,
            names::OVERLAY_SHOWN,
            names::TOAST_SHOW,
            names::LIBRARY_UPDATED,
            names::SETTINGS_CHANGED,
            names::MODELS_PROGRESS,
            // The recorder's *finished* event is the counter-example to
            // its tick: the library and the main window both need it.
            names::RECORDER_FINISHED,
            "clippity://some/unknown-event",
        ] {
            assert_eq!(
                target_for(event),
                EventTarget::Broadcast,
                "{event} must broadcast to all windows"
            );
        }
    }
}
