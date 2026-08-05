//! Screen-recording session orchestration (ADR 0031).
//!
//! One session, two outputs. A worker thread captures the selected
//! rectangle on a fixed cadence and feeds every frame to whichever
//! encoder the requested [`RecorderFormat`] selected — Media
//! Foundation's H.264/AAC muxer, or a streaming GIF encoder. Everything
//! before that fork (target resolution, pacing, the pause clock, audio
//! mixing, the HUD's status) is shared.
//!
//! Shaped after `scroll_capture_service`, which solved the same
//! problems first: a `Mutex<Option<ActiveSession>>` so only one session
//! can run, atomics for cross-thread control, and a worker that owns
//! its own state so the command thread never blocks on a frame.
//!
//! **The worker owns the encoder.** Media Foundation and WASAPI objects
//! are COM, therefore `!Send`, so they are created on the worker thread
//! and never leave it. What crosses the boundary is the control block
//! (atomics + a status snapshot) and, at the end, the result.
//!
//! **Everything streams.** No format buffers frames in memory: an hour
//! of 1080p is hundreds of gigabytes uncompressed, and GIF's ceiling
//! would still be over a gigabyte if its frames were held for a global
//! palette pass. Both encoders write through to a working file, which
//! is promoted into the captures directory only when the session
//! commits.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use image::RgbaImage;
use tauri::{AppHandle, Manager};
use xcap::Monitor;

use clippity_domain::developer::RecorderDiagnostics;
use clippity_domain::metadata::CaptureSource;
use clippity_domain::overlay::Region;
use clippity_domain::pixels::PixelOrder;
use clippity_domain::recorder::{
    self, RecorderFormat, RecorderRequest, RecorderResult, RecorderState, RecorderStatus,
    RecorderStopReason, ValidatedRecorderRequest,
};
use clippity_infra::error::{AppError, AppResult};
use clippity_infra::events;

use crate::capture_io::{next_id, promote_capture_file, resolve_save_dir};
use crate::overlay_service::{build_virtual_canvas_sdr, monitor_for_regions, virtual_bounds};
use crate::settings_service::{CapturesDirSource, NameTemplateSource, RecordingSettingsSource};
use crate::sidecar;
use crate::window_service;

mod compositor;
mod gif_sink;
mod mp4_sink;
pub mod sink;

use sink::{RecordingSink, SinkFrame};

/// One grabbed frame, in whatever channel order its source produced.
///
/// The buffer is handed back to the source after it has been encoded so
/// the steady state allocates nothing — a 5120x1440 frame is 28 MiB, and
/// asking the allocator for that sixty times a second is its own cost.
struct Captured {
    pixels: Vec<u8>,
    order: PixelOrder,
}

impl Captured {
    /// A borrowed view for the sink. The geometry is the region's,
    /// because that is what the grab was asked for — a buffer that
    /// disagrees is a bug the sink refuses rather than reads past.
    fn view(&self, region: Region) -> SinkFrame<'_> {
        SinkFrame {
            pixels: &self.pixels,
            width: region.width,
            height: region.height,
            order: self.order,
        }
    }
}

/// How often the worker publishes a status tick to the HUD.
///
/// Once a second, not once a frame: the HUD shows whole seconds and a
/// frame counter, so a 60 fps recording emitting per frame would wake
/// the toast WebView sixty times to redraw the same "00:07".
const TICK_INTERVAL: Duration = Duration::from_millis(500);

/// How often the audio meters are emitted. Ten a second — fast enough
/// that speech reads as movement rather than as a bar that flicks
/// between two values, slow enough that it costs the toast WebView a
/// fraction of what a per-frame event would.
///
/// Separate from [`TICK_INTERVAL`] rather than folded into it: the tick
/// carries elapsed time, frame counts and file size, none of which
/// anyone needs twenty times a second, and raising its rate would make
/// every existing reader pay for the meters.
const LEVELS_INTERVAL: Duration = Duration::from_millis(100);

/// Longest the worker will sleep in one go while paused or idle, so a
/// stop request is acted on promptly rather than after a whole frame
/// interval on a slow recording.
const CONTROL_POLL: Duration = Duration::from_millis(20);

/// Longest a single frame is left to cover a motionless screen before
/// being written again.
///
/// A still desktop produces no new frames at all, and the held frame
/// simply lasts longer — which is correct, and free. But the container
/// is *fragmented* so a killed session still plays (ADR 0031), and a
/// fragment only commits when something is written to it. Left
/// unbounded, a recording of a static screen would have nothing on disk
/// to recover. One second bounds what a crash can cost without writing
/// frames nobody needs.
const MAX_HELD_MS: u64 = 1_000;

/// Cross-thread session control. Atomics rather than a mutex so the
/// command thread can request a stop without ever waiting on a worker
/// that may be inside a blocking encoder call.
struct SessionControl {
    stop: AtomicBool,
    discard: AtomicBool,
    paused: AtomicBool,
    /// Latest published status, for `status()` between ticks.
    status: Mutex<RecorderStatus>,
    /// Mirrors `status.elapsed_ms` for lock-free reads from the pacing
    /// loop's own hot path.
    elapsed_ms: AtomicU64,
    /// Live per-source gain, as clamped percentages.
    ///
    /// Here rather than owned by the mixer for the same reason `stop` is
    /// here: the HUD adjusts them from the command thread, which must
    /// never block on a worker that may be inside a blocking encoder
    /// call. The worker re-reads them every poll, so a slider drag takes
    /// effect within one audio packet.
    ///
    /// Mute lives here too, as gain zero — see
    /// `domain::recorder::clamp_gain_pct` for why it needs no field of
    /// its own. `muted_gain` remembers the pre-mute value so unmuting
    /// restores the slider rather than snapping it to unity.
    mic_gain_pct: AtomicU16,
    system_gain_pct: AtomicU16,
    mic_premute_pct: AtomicU16,
    system_premute_pct: AtomicU16,
}

impl SessionControl {
    fn new(audio: &recorder::AudioSelection) -> Self {
        let mic = recorder::clamp_gain_pct(audio.microphone_gain_pct);
        let system = recorder::clamp_gain_pct(audio.system_gain_pct);
        Self {
            stop: AtomicBool::new(false),
            discard: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            status: Mutex::new(RecorderStatus {
                state: RecorderState::Recording,
                ..RecorderStatus::idle()
            }),
            elapsed_ms: AtomicU64::new(0),
            mic_gain_pct: AtomicU16::new(mic),
            system_gain_pct: AtomicU16::new(system),
            mic_premute_pct: AtomicU16::new(mic),
            system_premute_pct: AtomicU16::new(system),
        }
    }

    /// The two live gain slots for `source`: the current value and the
    /// remembered pre-mute one.
    fn gain_slots(&self, source: recorder::AudioSource) -> (&AtomicU16, &AtomicU16) {
        match source {
            recorder::AudioSource::Microphone => (&self.mic_gain_pct, &self.mic_premute_pct),
            recorder::AudioSource::System => (&self.system_gain_pct, &self.system_premute_pct),
        }
    }

    /// Set a source's gain. A non-zero value also becomes what unmuting
    /// will restore.
    fn set_gain(&self, source: recorder::AudioSource, pct: u16) {
        let pct = recorder::clamp_gain_pct(pct);
        let (current, premute) = self.gain_slots(source);
        current.store(pct, Ordering::Relaxed);
        if pct > 0 {
            premute.store(pct, Ordering::Relaxed);
        }
    }

    /// Mute or unmute a source, restoring the level it had before.
    ///
    /// Unmuting a source that was dragged to zero *and then* muted has
    /// nothing meaningful to restore, so it lands on unity rather than
    /// silently staying silent — an unmute that changes nothing reads as
    /// a broken button.
    fn set_muted(&self, source: recorder::AudioSource, muted: bool) {
        let (current, premute) = self.gain_slots(source);
        if muted {
            let live = current.load(Ordering::Relaxed);
            if live > 0 {
                premute.store(live, Ordering::Relaxed);
            }
            current.store(0, Ordering::Relaxed);
        } else {
            let restored = match premute.load(Ordering::Relaxed) {
                0 => recorder::GAIN_PCT_DEFAULT,
                pct => pct,
            };
            current.store(restored, Ordering::Relaxed);
        }
    }

    /// Current gain multiplier for `source`, as the mixer wants it.
    fn gain(&self, source: recorder::AudioSource) -> f32 {
        let (current, _) = self.gain_slots(source);
        recorder::gain_scalar(current.load(Ordering::Relaxed))
    }

    fn publish(&self, status: RecorderStatus) {
        self.elapsed_ms.store(status.elapsed_ms, Ordering::Relaxed);
        if let Ok(mut slot) = self.status.lock() {
            *slot = status;
        }
    }

    fn snapshot(&self) -> RecorderStatus {
        self.status
            .lock()
            .map(|s| *s)
            .unwrap_or_else(|_| RecorderStatus::idle())
    }
}

struct ActiveSession {
    control: Arc<SessionControl>,
    worker: JoinHandle<SessionOutcome>,
    /// What this session was *asked* to do — format, encoded size,
    /// frame rate, hardware preference. Captured at start because those
    /// are the only facts the outcome can't reconstruct, and completed
    /// with the session's counters on stop (see
    /// [`RecorderService::last_diagnostics`]).
    plan: RecorderDiagnostics,
    /// Primary window to put back when the session ends, for a
    /// recording that took over from the overlay (`OverlayService::dismiss`
    /// hid it and handed the label over). `None` for a session started
    /// directly — nothing was hidden, so restoring would *show* a window
    /// the user never had open.
    restore_on_stop: Option<String>,
}

/// What the worker hands back when it finishes.
struct SessionOutcome {
    reason: RecorderStopReason,
    result: Option<RecorderResult>,
    /// Populated when the session ended badly, for the error toast.
    error: Option<String>,
}

pub struct RecorderService {
    active: Mutex<Option<ActiveSession>>,
    captures: Arc<dyn CapturesDirSource>,
    naming: Arc<dyn NameTemplateSource>,
    prefs: Arc<dyn RecordingSettingsSource>,
    /// What the last session did, kept after it ends.
    ///
    /// The live `RecorderStatus` is gone the moment the HUD closes, but
    /// "why did that clip drop a third of its frames?" is asked *after*
    /// the recording, in Settings → Advanced. One slot, not a history:
    /// the question is always about the one that just went wrong.
    last: Mutex<Option<RecorderDiagnostics>>,
}

impl RecorderService {
    pub fn new(
        captures: Arc<dyn CapturesDirSource>,
        naming: Arc<dyn NameTemplateSource>,
        prefs: Arc<dyn RecordingSettingsSource>,
    ) -> Self {
        Self {
            active: Mutex::new(None),
            captures,
            naming,
            prefs,
            last: Mutex::new(None),
        }
    }

    /// Statistics from the most recent session, or `None` when nothing
    /// has been recorded since launch.
    pub fn last_diagnostics(&self) -> Option<RecorderDiagnostics> {
        self.last.lock().ok().and_then(|s| s.clone())
    }

    /// Complete `plan` with what the session actually produced, and keep
    /// it. Called on every stop, whichever way the session ended.
    fn remember(
        &self,
        mut plan: RecorderDiagnostics,
        status: &RecorderStatus,
        outcome: &SessionOutcome,
    ) {
        plan.frames = status.frames;
        plan.dropped = status.dropped;
        plan.duration_ms = outcome
            .result
            .as_ref()
            .map(|r| r.duration_ms)
            .unwrap_or(status.elapsed_ms);
        // The committed file's size, not the working file's: a discarded
        // session wrote bytes that no longer exist.
        plan.bytes = match &outcome.result {
            Some(r) => std::fs::metadata(&r.path)
                .map(|m| m.len())
                .unwrap_or(status.bytes),
            None => 0,
        };
        plan.had_audio = outcome.result.as_ref().is_some_and(|r| r.has_audio);
        plan.outcome = match (&outcome.error, &outcome.result) {
            (Some(_), _) => "failed",
            (None, Some(_)) => "committed",
            (None, None) => "discarded",
        }
        .to_string();

        if let Ok(mut slot) = self.last.lock() {
            *slot = Some(plan);
        }
    }

    /// Validate the request, resolve the rectangle, and start the
    /// worker. Returns the session's opening status so the HUD can
    /// render immediately rather than waiting for the first tick.
    ///
    /// `restore_on_stop` is the primary window to put back when the
    /// session ends — `Some` only when a recording took over from the
    /// overlay, which hid it. See `OverlayService::dismiss`.
    pub fn start(
        &self,
        app: &AppHandle,
        request: RecorderRequest,
        restore_on_stop: Option<String>,
    ) -> AppResult<RecorderStatus> {
        let mut active = self.lock_active()?;
        // Reap a session that ended on its own — a duration limit, or a
        // failure — and was never stopped by anyone. Without this, one
        // self-stopped session would refuse every later recording for
        // the rest of the process's life.
        if active.as_ref().is_some_and(|s| s.worker.is_finished()) {
            if let Some(session) = active.take() {
                // Keep its statistics on the way past: a session that
                // ended on its own is the one most worth looking at,
                // and nobody called `stop` to record it.
                let status = session.control.snapshot();
                if let Ok(outcome) = session.worker.join() {
                    self.remember(session.plan, &status, &outcome);
                }
            }
        }
        if active.is_some() {
            return Err(AppError::Recorder(
                "a recording is already in progress".into(),
            ));
        }

        let (_, _, virtual_w, virtual_h) = virtual_bounds()?;
        // Fullscreen resolves to the monitor under the cursor, matching
        // where the still Fullscreen mode shoots.
        let fullscreen = match request.target {
            recorder::RecorderTarget::Fullscreen => Some(cursor_monitor_region()?),
            _ => None,
        };
        let validated = recorder::validate(request, virtual_w, virtual_h, fullscreen)
            .map_err(|e| AppError::Recorder(e.to_string()))?;

        // Resolved once, at start: a recording spans minutes, so there
        // is no single later instant to attribute it to, and the region
        // does not move during a session.
        let source_monitor = monitor_for_regions(&[validated.region]);
        // Kept before `validated` is moved into the worker.
        let validated_region = validated.region;
        // What this session was asked to do. Only the request knows the
        // encoded size and the hardware preference, and the request is
        // about to be moved onto the worker thread.
        let (plan_width, plan_height) = validated.output_size();
        let plan = RecorderDiagnostics {
            format: match validated.format {
                RecorderFormat::Mp4 => "mp4".into(),
                RecorderFormat::Gif => "gif".into(),
            },
            width: plan_width,
            height: plan_height,
            target_fps: validated.fps,
            preferred_hardware: validated.encoding.prefer_hardware,
            ..Default::default()
        };
        let captures_dir = resolve_save_dir(
            validated.output_dir.as_deref(),
            self.captures.captures_dir(),
        );
        let template = self.naming.name_template();

        let control = Arc::new(SessionControl::new(&validated.audio));
        let worker = {
            let app = app.clone();
            let control = Arc::clone(&control);
            std::thread::spawn(move || {
                run_session(
                    app,
                    validated,
                    control,
                    captures_dir,
                    template,
                    source_monitor,
                )
            })
        };

        // Frame the recorded area for the length of the session. Shown
        // after the worker is running so it can't be left on screen by a
        // start that failed — and it is the only thing on screen saying
        // what is being recorded once the overlay is down.
        if self.prefs.recording().outline {
            show_outline(app, validated_region);
        }

        *active = Some(ActiveSession {
            control: Arc::clone(&control),
            worker,
            plan,
            restore_on_stop,
        });
        Ok(control.snapshot())
    }

    /// Hold the recording. The worker keeps running but stops capturing
    /// and stops advancing the clock, so the file's timeline has no gap.
    pub fn pause(&self) -> AppResult<RecorderStatus> {
        self.set_paused(true)
    }

    pub fn resume(&self) -> AppResult<RecorderStatus> {
        self.set_paused(false)
    }

    fn set_paused(&self, paused: bool) -> AppResult<RecorderStatus> {
        let active = self.lock_active()?;
        let session = active
            .as_ref()
            .ok_or_else(|| AppError::Recorder("no recording is in progress".into()))?;
        session.control.paused.store(paused, Ordering::Relaxed);
        // Reflect the transition immediately rather than waiting for the
        // worker's next tick — the HUD button must not appear stuck.
        let mut status = session.control.snapshot();
        status.state = if paused {
            RecorderState::Paused
        } else {
            RecorderState::Recording
        };
        session.control.publish(status);
        Ok(status)
    }

    /// Set one input's level mid-session, as a percentage of unity.
    ///
    /// **A no-op when nothing is recording**, unlike `pause` — which
    /// errors on an idle session because pausing nothing is a caller
    /// bug. This one is a slider: the HUD can be closing while the user
    /// is still dragging, and turning that race into an error toast
    /// would be noise about something that no longer matters.
    ///
    /// Adjusts only the live session. The persisted default lives in
    /// `RecordingSettings` and is deliberately not written here — a
    /// level nudged for one recording should not silently become the
    /// level every future recording starts at.
    pub fn set_gain(&self, source: recorder::AudioSource, pct: u16) {
        self.with_session(|s| s.control.set_gain(source, pct));
    }

    /// Mute or unmute one input mid-session, restoring its previous
    /// level on unmute. Same no-op-when-idle rule as [`Self::set_gain`].
    pub fn set_muted(&self, source: recorder::AudioSource, muted: bool) {
        self.with_session(|s| s.control.set_muted(source, muted));
    }

    fn with_session(&self, f: impl FnOnce(&ActiveSession)) {
        if let Ok(active) = self.active.lock() {
            if let Some(session) = active.as_ref() {
                f(session);
            }
        }
    }

    /// Current status, or the idle status when nothing is recording.
    pub fn status(&self) -> RecorderStatus {
        self.active
            .lock()
            .ok()
            .and_then(|a| a.as_ref().map(|s| s.control.snapshot()))
            .unwrap_or_else(RecorderStatus::idle)
    }

    /// Stop the session and join the worker.
    ///
    /// `discard` throws the working file away; otherwise it is promoted
    /// into the captures directory. Returns `None` for a discard, or
    /// when nothing was recording.
    ///
    /// Emits nothing: `recorder/finished` is the **worker's** to send,
    /// because a session can also end without anyone calling this — a
    /// duration limit, or a capture failure. Emitting here too would
    /// double-fire for every ordinary stop. The HUD listens for the
    /// event and calls this to reap, so both paths converge.
    pub fn stop(&self, app: &AppHandle, discard: bool) -> AppResult<Option<RecorderResult>> {
        let session = {
            let mut active = self.lock_active()?;
            active.take()
        };
        let Some(session) = session else {
            return Ok(None);
        };

        // Down first: the outline is a promise that a recording is
        // running, and leaving it up through the encoder's finalize
        // (which can take a moment on a long file) says the session is
        // still going when it isn't.
        hide_outline(app);

        session.control.discard.store(discard, Ordering::Relaxed);
        session.control.stop.store(true, Ordering::Relaxed);
        // Un-pause so a paused worker leaves its wait loop and reaches
        // the stop check instead of hanging the join.
        session.control.paused.store(false, Ordering::Relaxed);

        // Read the counters before the join: the control block is the
        // only place the frame and drop totals live, and the worker's
        // outcome doesn't carry them.
        let final_status = session.control.snapshot();
        let outcome = session
            .worker
            .join()
            .map_err(|_| AppError::Recorder("the recording worker stopped unexpectedly".into()))?;
        self.remember(session.plan, &final_status, &outcome);

        // Put back the window the overlay hid on the way in — after the
        // worker has stopped, so it can't appear in the last frames.
        // Skipped entirely for a session started outside the overlay:
        // nothing was hidden, and `restore_window` *shows* its target,
        // so restoring would open a window the user never had up.
        if let Some(label) = session.restore_on_stop {
            window_service::restore_window(app, &label);
        }

        if let Some(error) = outcome.error {
            return Err(AppError::Recorder(error));
        }
        Ok(outcome.result)
    }

    fn lock_active(&self) -> AppResult<std::sync::MutexGuard<'_, Option<ActiveSession>>> {
        self.active
            .lock()
            .map_err(|_| AppError::Recorder("recorder lock poisoned".into()))
    }
}

/// Label of the click-through window that frames the recorded area.
const FRAME_WINDOW: &str = "recorder-frame";

/// Put the recording outline around `region` and show it.
///
/// Best-effort throughout: an outline that cannot be positioned must
/// never cost the user their recording. Every failure is logged and the
/// session continues without it.
///
/// The rect is in canvas coordinates, so the virtual-desktop origin is
/// added back to reach the physical screen coordinates the window
/// manager wants — `(0, 0)` on the canvas is the top-left of the
/// *virtual* desktop, which on a multi-monitor setup is frequently
/// negative in screen space.
fn show_outline(app: &AppHandle, region: Region) {
    let Some(frame) = app.get_webview_window(FRAME_WINDOW) else {
        return;
    };
    let Ok((min_x, min_y, vw, vh)) = virtual_bounds() else {
        return;
    };
    let outline = recorder::outline_frame(region, vw, vh);

    if let Err(e) = frame.set_position(tauri::PhysicalPosition::new(
        min_x + outline.x as i32,
        min_y + outline.y as i32,
    )) {
        tracing::warn!("recording outline not positioned: {e}");
        return;
    }
    if let Err(e) = frame.set_size(tauri::PhysicalSize::new(outline.width, outline.height)) {
        tracing::warn!("recording outline not sized: {e}");
        return;
    }
    let _ = frame.set_always_on_top(true);
    // Pure indicator: never intercept a click meant for whatever is
    // being recorded — the user is working inside this rectangle.
    let _ = frame.set_ignore_cursor_events(true);
    if let Err(e) = frame.show() {
        tracing::warn!("recording outline not shown: {e}");
    }
}

/// Take the outline down. Safe to call when it was never shown.
fn hide_outline(app: &AppHandle) {
    if let Some(frame) = app.get_webview_window(FRAME_WINDOW) {
        let _ = frame.hide();
    }
}

/// Payload of `clippity://recorder/finished`.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FinishedPayload {
    reason: RecorderStopReason,
    result: Option<RecorderResult>,
}

fn emit_finished(app: &AppHandle, outcome: &SessionOutcome) {
    let _ = events::emit(
        app,
        events::names::RECORDER_FINISHED,
        FinishedPayload {
            reason: outcome.reason,
            result: outcome.result.clone(),
        },
    );
}

/// The worker body: set up the encoder, run the capture loop, then
/// commit or discard.
///
/// Never returns `Err` — every exit path produces a [`SessionOutcome`],
/// because a recording that failed halfway still has a file the user
/// should get. The error travels in the outcome instead.
fn run_session(
    app: AppHandle,
    request: ValidatedRecorderRequest,
    control: Arc<SessionControl>,
    captures_dir: PathBuf,
    template: String,
    source_monitor: Option<String>,
) -> SessionOutcome {
    let outcome = match run_session_inner(
        &app,
        &request,
        &control,
        &captures_dir,
        &template,
        source_monitor.as_deref(),
    ) {
        Ok(outcome) => outcome,
        Err(e) => SessionOutcome {
            reason: RecorderStopReason::Failed,
            result: None,
            error: Some(e.to_string()),
        },
    };

    // Announced here, not in `stop`, because the worker is the only
    // party present on every exit path — including the ones nobody
    // asked for (a duration limit, a failed encoder). The HUD reacts to
    // this event and calls `stop` to reap, so a user-pressed Stop and a
    // self-stop end the same way.
    emit_finished(&app, &outcome);
    if outcome.result.is_some() {
        let _ = events::emit(&app, events::names::LIBRARY_UPDATED, ());
    }
    outcome
}

fn run_session_inner(
    app: &AppHandle,
    request: &ValidatedRecorderRequest,
    control: &Arc<SessionControl>,
    captures_dir: &PathBuf,
    template: &str,
    source_monitor: Option<&str>,
) -> AppResult<SessionOutcome> {
    // COM + Media Foundation live for exactly this thread's lifetime.
    #[cfg(target_os = "windows")]
    let _com = clippity_platform::windows::media_foundation::ComThread::init()?;

    std::fs::create_dir_all(captures_dir)?;
    // The working file sits in the destination directory so the commit
    // is a same-volume rename. Dot-prefixed so the library scan skips
    // it — an in-progress recording must not appear as a row, and a
    // file orphaned by a crash must not either.
    let working = captures_dir.join(format!(
        ".clippity-recording-{}.{}",
        next_id(),
        request.format.extension()
    ));

    let mut sink = sink::open(
        &working,
        request.format,
        sink::SinkConfig::for_recording(request),
    )?;
    let mut audio = AudioMixer::open(request);
    // Sources are opened against the *captured* geometry and the
    // capture's own channel order, so the blend is a straight composite
    // over bytes already in the right order (ADR 0033). Opened before
    // the loop and never gated on: a source that fails is logged and
    // simply not drawn.
    // Opened lazily on the first frame: the capture's channel order is
    // not known until one arrives, and `FrameSource` may fall back to a
    // different one mid-session.
    let mut sources: Option<compositor::Compositor> = None;

    let frame_interval = Duration::from_millis(recorder::frame_interval_ms(request.fps));
    let started = Instant::now();
    let mut last_instant = started;
    let mut recorded = Duration::ZERO;
    // The most recent capture, held back until the next one arrives so
    // its true on-screen duration can be measured. See the write below.
    let mut pending: Option<(Captured, u64)> = None;
    // A written frame's buffer, on its way back to be filled again.
    let mut recycle: Option<Vec<u8>> = None;
    // The frame source stays open for the session — see `FrameSource`.
    #[cfg(target_os = "windows")]
    let mut source = FrameSource::open(request.region);
    #[cfg(not(target_os = "windows"))]
    let mut source = FrameSource::OneShot;
    // Samples actually handed to the sink. Distinct from `frames`, which
    // counts *captures* for the HUD and runs one ahead of this while a
    // frame is held. Only the first write needs to know it is first.
    let mut written: u64 = 0;
    let mut next_frame = Instant::now();
    let mut last_tick = Instant::now();
    let mut last_levels = Instant::now();
    let mut frames: u64 = 0;
    let mut dropped: u64 = 0;
    // Assigned on every path out of the loop below — there is no
    // default outcome, and letting the compiler prove that is better
    // than seeding a value that would silently stand in if a future
    // `break` forgot to set one.
    let mut reason;
    let mut failure: Option<String> = None;
    // PNG of the session's first frame, written beside the finished
    // recording so the library has something to draw.
    let mut poster: Option<Vec<u8>> = None;

    loop {
        if control.stop.load(Ordering::Relaxed) {
            reason = if control.discard.load(Ordering::Relaxed) {
                RecorderStopReason::Discarded
            } else {
                RecorderStopReason::Committed
            };
            break;
        }

        let now = Instant::now();
        let delta = now.saturating_duration_since(last_instant);
        last_instant = now;

        if control.paused.load(Ordering::Relaxed) {
            // Paused: the clock does not advance and nothing is
            // captured, so the file has no gap. Audio is drained and
            // dropped rather than left to pile up in the endpoint's
            // buffer, which would surface as a burst of stale sound on
            // resume.
            audio.discard();
            std::thread::sleep(CONTROL_POLL);
            next_frame = Instant::now();
            continue;
        }

        recorded += delta;
        let elapsed_ms = recorded.as_millis() as u64;

        if recorder::duration_limit_reached(elapsed_ms, request.format) {
            reason = RecorderStopReason::DurationLimit;
            break;
        }

        // --- video ---
        //
        // `Ok(None)` means the screen has not changed. Nothing is
        // written: the frame already held simply lasts longer, which is
        // exactly what it should do and costs nothing — and on a screen
        // recording, most frames are that.
        match source.next(request.region, recycle.take()) {
            // Unchanged. The held frame goes on covering this instant,
            // at no cost at all — until `MAX_HELD_MS` has passed, when
            // it is written once so the fragmented container keeps
            // committing and a killed session still plays (ADR 0031).
            //
            // Written *in place* rather than cloned and re-grabbed: the
            // picture is the one already in hand, so copying 28 MiB to
            // hand it back to itself bought nothing. It also stops a
            // motionless screen inflating the HUD's frame counter —
            // nothing was captured here, so nothing is counted.
            Ok(None) => {
                if let Some((held, since)) = pending.as_mut() {
                    if elapsed_ms.saturating_sub(*since) >= MAX_HELD_MS {
                        // The screen has not changed, but a source may
                        // have. Restore the captured pixels under each
                        // source and blend again — without this the
                        // webcam freezes exactly when it is the only
                        // thing still moving, and a translucent source
                        // compounds over its own output (ADR 0033).
                        if let Some(compositor) = sources.as_mut() {
                            compositor.redraw(
                                &mut held.pixels,
                                request.region.width,
                                request.region.height,
                                held.order,
                            );
                        }
                        let (timestamp, duration) =
                            recorder::frame_placement(*since, elapsed_ms, written == 0);
                        written += 1;
                        let write =
                            sink.write_frame(held.view(request.region), timestamp, duration);
                        *since = elapsed_ms;
                        if let Err(e) = write {
                            failure = Some(e.to_string());
                            reason = RecorderStopReason::Failed;
                            break;
                        }
                    }
                }
            }
            Ok(Some(frame)) => {
                // Write the *previous* frame, now that this one's
                // timestamp says how long it was actually on screen.
                //
                // A frame is held back for exactly one iteration because
                // its duration cannot be known until its successor
                // arrives, and stating that duration correctly is what
                // makes the file seekable. The nominal `1/fps` used to
                // go out instead, which is only true when the capture
                // keeps up: at 5120x1440 a grab can take a third of a
                // second, so each sample claimed 33 ms and the next
                // began 300 ms later. Everything between was a hole with
                // no frame in it — a player cannot seek into one, so the
                // playhead skids to the far side, and playback runs out
                // of pictures long before the clip's stated end.
                if let Some((previous, previous_ms)) = pending.take() {
                    let (timestamp, duration) =
                        recorder::frame_placement(previous_ms, elapsed_ms, written == 0);
                    written += 1;
                    let write =
                        sink.write_frame(previous.view(request.region), timestamp, duration);
                    // Hand the written frame's buffer back to be filled
                    // again, so the steady state does no allocation.
                    // Taken before the error check so a failing write
                    // still returns it rather than leaking a frame's
                    // worth of memory on the way out.
                    recycle = Some(previous.pixels);
                    if let Err(e) = write {
                        failure = Some(e.to_string());
                        reason = RecorderStopReason::Failed;
                        break;
                    }
                }
                // Draw the session's sources over the capture before
                // anything reads it — the poster included, so the
                // library's thumbnail shows the same picture the file
                // does.
                let mut frame = frame;
                if !request.sources.is_empty() {
                    let compositor = sources.get_or_insert_with(|| {
                        compositor::Compositor::open(
                            &request.sources,
                            request.region.width,
                            request.region.height,
                            frame.order,
                        )
                    });
                    // Empty when every source failed to open — a
                    // camera another app holds, an image since deleted.
                    // The session records regardless (ADR 0033).
                    if !compositor.is_empty() {
                        compositor.draw(
                            &mut frame.pixels,
                            request.region.width,
                            request.region.height,
                            frame.order,
                        );
                    }
                }
                // Keep the very first frame as the library's poster. A
                // frame we already hold costs one PNG encode; the
                // alternative is opening a video decoder every time the
                // library draws a row.
                if frames == 0 {
                    poster = encode_poster(frame.view(request.region));
                }
                pending = Some((frame, elapsed_ms));
                frames += 1;
            }
            Err(e) => {
                // A single failed grab (a mode switch, a UAC prompt
                // taking the desktop) must not end the recording — the
                // user is still recording something. Count it and carry
                // on; a climbing dropped count is what the HUD shows.
                dropped += 1;
                if dropped % 30 == 1 {
                    tracing::warn!("recorder dropped a frame: {e}");
                }
            }
        }

        // --- audio ---
        if let Err(e) = audio.pump(&mut sink, control.as_ref()) {
            // Audio failing mid-session degrades to silence rather than
            // ending the recording.
            tracing::warn!("recorder audio stopped: {e}");
            audio.disable();
        }

        // --- status ---
        if now.duration_since(last_tick) >= TICK_INTERVAL {
            last_tick = now;
            let status = RecorderStatus {
                state: RecorderState::Recording,
                elapsed_ms,
                frames,
                dropped,
                bytes: sink.bytes_written(),
            };
            control.publish(status);
            let _ = events::emit(app, events::names::RECORDER_TICK, status);
        }

        // --- meters ---
        // On their own cadence, faster than the status tick: a meter
        // that updates twice a second reads as broken, and the status
        // payload is not worth sending at meter rate.
        if now.duration_since(last_levels) >= LEVELS_INTERVAL {
            last_levels = now;
            if let Some(levels) = audio.take_levels() {
                let _ = events::emit(app, events::names::RECORDER_LEVELS, levels);
            }
        }

        // --- pace ---
        next_frame += frame_interval;
        let now = Instant::now();
        if next_frame > now {
            std::thread::sleep((next_frame - now).min(frame_interval));
        } else {
            // Behind schedule: the encoder or the grab is slower than
            // the requested rate. Re-base rather than trying to catch
            // up, which would spin without ever recovering.
            //
            // The *number of intervals* missed, not one per late
            // iteration. A loop running at half the requested rate skips
            // one frame each time round and used to report one drop per
            // pass, which reads as a light stutter; a loop running at a
            // tenth skips nine and reported the same. The count only
            // means anything to the user — "lower the frame rate" — if
            // it says how many frames the file does not have.
            let behind = now.saturating_duration_since(next_frame) + frame_interval;
            dropped += (behind.as_nanos() / frame_interval.as_nanos().max(1)).max(1) as u64;
            next_frame = now;
        }
    }

    let elapsed_ms = recorded.as_millis() as u64;

    // The frame still in hand has no successor to measure against, so it
    // runs to wherever the session actually stopped. Without this the
    // recording loses its final frame *and* ends early — the container
    // would stop at the second-to-last capture, which on a slow grab is
    // a visible fraction of a second missing from the end.
    //
    // Skipped on a failed session, where the sink is already unhappy and
    // one more write would only change which error is reported.
    if let Some((last, last_ms)) = pending.take() {
        if reason != RecorderStopReason::Failed {
            // The same rule, so a session short enough that only one
            // grab ever succeeded still starts at zero.
            let (timestamp, duration) =
                recorder::frame_placement(last_ms, elapsed_ms, written == 0);
            if let Err(e) = sink.write_frame(last.view(request.region), timestamp, duration) {
                tracing::warn!("recorder could not write its final frame: {e}");
            }
        }
    }

    // The encoded size, not the captured one. They differ whenever a
    // resolution cap or GIF's pixel budget applied, and this number is
    // what the library indexes and the inspector shows — reporting the
    // region would describe a file that doesn't exist.
    let (width, height) = request.output_size();
    let has_audio = audio.captured_anything();

    // Close the encoder before touching the file — the trailer has to
    // be on disk before the rename.
    let close = sink.finish();
    if let Err(e) = close {
        if failure.is_none() {
            failure = Some(e.to_string());
            reason = RecorderStopReason::Failed;
        }
    }

    if !reason.keeps_output() || frames == 0 {
        // Discarded, or nothing was ever captured — a zero-frame file
        // is not a recording, and promoting it would put an unplayable
        // row in the library.
        let _ = std::fs::remove_file(&working);
        return Ok(SessionOutcome {
            reason,
            result: None,
            error: failure,
        });
    }

    let source = CaptureSource::from_mode(mode_label(request))
        .with_size(width, height)
        .with_monitor(source_monitor);
    let path = promote_capture_file(
        &working,
        captures_dir,
        template,
        &source,
        request.format.extension(),
    )?;

    // After the promotion, so the poster is keyed to the recording's
    // final name — a poster written against the working file's name
    // would be orphaned the moment it was renamed.
    if let Some(png) = poster {
        if let Err(e) = sidecar::write_poster(&path, &png) {
            tracing::warn!("recording poster not written: {e:?}");
        }
    }

    // Also after the promotion, and for a sharper version of the same
    // reason: the clipboard holds a *path*, so copying the working file
    // would hand the user a reference that goes stale one rename later.
    if request.toggles.clipboard {
        if let Err(e) = copy_file_to_clipboard(&path) {
            // Logged, never fatal. The recording is on disk and is the
            // thing the user asked for; a clipboard the OS wouldn't
            // hand over (another app holding it is the common case) is
            // not worth failing a finished session over.
            tracing::warn!("recording not copied to the clipboard: {e}");
        }
    }

    Ok(SessionOutcome {
        reason,
        result: Some(RecorderResult {
            id: next_id(),
            target: request.target,
            format: request.format,
            width,
            height,
            path: path.to_string_lossy().into_owned(),
            duration_ms: elapsed_ms,
            frames,
            has_audio,
            preview: request.toggles.preview,
        }),
        error: failure,
    })
}

/// Put the finished recording on the system clipboard as a file
/// reference, so it pastes into a chat or a folder as an attachment.
///
/// Split out behind a `cfg` because the mechanism is `CF_HDROP` and has
/// no cross-platform stand-in: `arboard`, which every other clipboard
/// path in the app uses, copies content rather than files. On a
/// non-Windows build this reports the gap rather than silently claiming
/// to have copied something.
#[cfg(target_os = "windows")]
fn copy_file_to_clipboard(path: &std::path::Path) -> Result<(), String> {
    clippity_platform::windows::clipboard_files::copy_files_to_clipboard(&[path])
}

#[cfg(not(target_os = "windows"))]
fn copy_file_to_clipboard(_path: &std::path::Path) -> Result<(), String> {
    Err("copying a recording to the clipboard is Windows-only".into())
}

/// Encode a captured frame as the library's poster PNG.
///
/// Downscaled first: the library asks for a few hundred pixels wide, so
/// storing a full 4K frame per recording would cost more disk than some
/// of the recordings themselves.
///
/// Materialising the frame here is fine where it would not be in the
/// encode path: this runs once per session, not once per frame.
fn encode_poster(frame: SinkFrame<'_>) -> Option<Vec<u8>> {
    let (w, h) = frame.dimensions();
    if w == 0 || h == 0 {
        return None;
    }
    let source = frame.to_rgba_image()?;
    let scale = (POSTER_MAX_EDGE as f64 / w.max(h) as f64).min(1.0);
    let small = image::imageops::thumbnail(
        &source,
        ((w as f64 * scale).round() as u32).max(1),
        ((h as f64 * scale).round() as u32).max(1),
    );
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(small)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .ok()
        .map(|_| png)
}

/// Longest edge of a stored poster frame. Comfortably above the widest
/// thumbnail the library requests, so a card never upscales.
const POSTER_MAX_EDGE: u32 = 640;

/// Label stamped into the file name and the provenance record.
fn mode_label(request: &ValidatedRecorderRequest) -> &'static str {
    match (request.format, request.target) {
        (RecorderFormat::Gif, _) => "GIF",
        (RecorderFormat::Mp4, recorder::RecorderTarget::Region) => "Recording",
        (RecorderFormat::Mp4, recorder::RecorderTarget::Window) => "Window Recording",
        (RecorderFormat::Mp4, recorder::RecorderTarget::Fullscreen) => "Screen Recording",
    }
}

/// The monitor the cursor currently sits on, in canvas coordinates.
fn cursor_monitor_region() -> AppResult<Region> {
    let (min_x, min_y, _, _) = virtual_bounds()?;
    let (cx, cy) = cursor_position().unwrap_or((min_x, min_y));
    let monitor = Monitor::from_point(cx, cy)
        .map_err(|e| AppError::Recorder(format!("no monitor under the cursor: {e}")))?;
    let x = monitor.x().map_err(monitor_err)?;
    let y = monitor.y().map_err(monitor_err)?;
    let width = monitor.width().map_err(monitor_err)?;
    let height = monitor.height().map_err(monitor_err)?;
    Ok(Region {
        x: (x - min_x).max(0) as u32,
        y: (y - min_y).max(0) as u32,
        width,
        height,
    })
}

fn monitor_err(e: xcap::XCapError) -> AppError {
    AppError::Recorder(format!("monitor query failed: {e}"))
}

#[cfg(target_os = "windows")]
fn cursor_position() -> Option<(i32, i32)> {
    clippity_platform::windows::cursor::screen_position()
}

#[cfg(not(target_os = "windows"))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

/// Grab one frame of the recorded rectangle.
///
/// Prefers a direct region grab from the single monitor that contains
/// the rectangle — a BitBlt of just those pixels. Falls back to
/// compositing the whole virtual desktop and cropping only when the
/// rectangle straddles two monitors, which is both rare and much more
/// expensive; doing it always would put a full multi-monitor capture in
/// every frame's budget.
/// The recorder's frame source.
///
/// A recording asks for a frame thirty times a second, and the one-shot
/// grab every other capture in the app uses builds and destroys a
/// capture session around each call — 34 ms of it on a 5120x1440 output,
/// against a 33 ms budget. This holds a duplication open instead, so
/// that cost is paid once per session rather than once per frame.
///
/// Falls back to the one-shot path rather than failing. Duplication is
/// legitimately refusable — a remote session, another tool holding the
/// output, a region spanning two monitors — and none of those should
/// cost the user their recording. A slow recording beats no recording.
#[cfg(target_os = "windows")]
enum FrameSource {
    /// An open duplication, plus the region within its output.
    Held {
        duplicator: clippity_platform::windows::duplication_capture::MonitorDuplicator,
        local_x: u32,
        local_y: u32,
        /// Recycled between frames so the steady state allocates
        /// nothing: a 5120x1440 frame is 28 MiB, and asking the
        /// allocator for that thirty times a second is its own cost.
        scratch: Vec<u8>,
    },
    /// Per-call grabs, for when duplication is unavailable.
    OneShot,
}

#[cfg(target_os = "windows")]
impl FrameSource {
    /// Open the best source available for `region`.
    fn open(region: Region) -> Self {
        use clippity_platform::windows::duplication_capture::MonitorDuplicator;

        let Ok((min_x, min_y, _, _)) = virtual_bounds() else {
            return Self::OneShot;
        };
        let absolute_x = min_x + region.x as i32;
        let absolute_y = min_y + region.y as i32;

        match MonitorDuplicator::open_at(absolute_x, absolute_y) {
            Ok(duplicator) => {
                let (origin_x, origin_y) = duplicator.origin();
                let (local_x, local_y) = (absolute_x - origin_x, absolute_y - origin_y);
                // A region hanging off the output — or starting before
                // it — has to go the long way round, which composites
                // the whole virtual desktop.
                if local_x < 0
                    || local_y < 0
                    || !duplicator.covers(
                        local_x as u32,
                        local_y as u32,
                        region.width,
                        region.height,
                    )
                {
                    tracing::debug!("recording region spans outputs; using per-call grabs");
                    return Self::OneShot;
                }
                Self::Held {
                    duplicator,
                    local_x: local_x as u32,
                    local_y: local_y as u32,
                    scratch: Vec::new(),
                }
            }
            Err(e) => {
                tracing::debug!("desktop duplication unavailable, using per-call grabs: {e}");
                Self::OneShot
            }
        }
    }

    /// Next frame, or `Ok(None)` when the screen has not changed.
    ///
    /// `recycle` hands back a previous frame's buffer to be written into
    /// again. Nothing depends on it being the right size — it is
    /// resized — only on it being large enough to have stopped growing.
    ///
    /// The frame comes back in whatever order its source produced:
    /// BGRA from a duplication read-back, RGBA from the one-shot
    /// fallback. Neither is normalised here — see
    /// `sink::SinkFrame` for why the order travels instead.
    fn next(&mut self, region: Region, recycle: Option<Vec<u8>>) -> AppResult<Option<Captured>> {
        use clippity_platform::windows::duplication_capture::Grab;

        match self {
            Self::Held {
                duplicator,
                local_x,
                local_y,
                scratch,
            } => {
                if let Some(buffer) = recycle {
                    if buffer.capacity() > scratch.capacity() {
                        *scratch = buffer;
                    }
                }
                match duplicator.grab_bgra(*local_x, *local_y, region.width, region.height, scratch)
                {
                    // Nothing moved. The caller keeps the frame it has,
                    // which — because a frame now lasts until the next
                    // one arrives — simply stays on screen for longer.
                    Ok(Grab::Unchanged) => Ok(None),
                    Ok(Grab::Fresh) => {
                        let expected = region.width as usize * region.height as usize * 4;
                        if scratch.len() != expected {
                            return Err(AppError::Recorder(
                                "a grabbed frame had the wrong size".into(),
                            ));
                        }
                        Ok(Some(Captured {
                            pixels: std::mem::take(scratch),
                            order: PixelOrder::Bgra,
                        }))
                    }
                    // The duplication is finished — a resolution change,
                    // a full-screen app, a lock screen. Drop to the
                    // one-shot path for the rest of the session rather
                    // than ending the recording.
                    Err(e) => {
                        tracing::warn!("desktop duplication ended, falling back: {e}");
                        *self = Self::OneShot;
                        one_shot(region).map(Some)
                    }
                }
            }
            Self::OneShot => one_shot(region).map(Some),
        }
    }
}

/// A single grab through the per-call path, as a [`Captured`].
///
/// `xcap` and the virtual-canvas fallback both hand back RGBA, so that
/// is the order this reports — the whole point of carrying it is that
/// the two capture paths no longer have to agree.
fn one_shot(region: Region) -> AppResult<Captured> {
    capture_frame(region).map(|frame| Captured {
        pixels: frame.into_raw(),
        order: PixelOrder::Rgba,
    })
}

fn capture_frame(region: Region) -> AppResult<RgbaImage> {
    let (min_x, min_y, _, _) = virtual_bounds()?;
    let absolute_x = min_x + region.x as i32;
    let absolute_y = min_y + region.y as i32;

    if let Ok(monitor) = Monitor::from_point(absolute_x, absolute_y) {
        let mx = monitor.x().map_err(monitor_err)?;
        let my = monitor.y().map_err(monitor_err)?;
        let mw = monitor.width().map_err(monitor_err)?;
        let mh = monitor.height().map_err(monitor_err)?;

        let local_x = absolute_x - mx;
        let local_y = absolute_y - my;
        let fits = local_x >= 0
            && local_y >= 0
            && local_x as u32 + region.width <= mw
            && local_y as u32 + region.height <= mh;
        if fits {
            return monitor
                .capture_region(local_x as u32, local_y as u32, region.width, region.height)
                .map_err(|e| AppError::Recorder(format!("frame grab failed: {e}")));
        }
    }

    // The SDR variant deliberately: this runs once per frame, and the
    // HDR-accurate path sets up a Direct3D device and a staging
    // read-back per HDR monitor per call. See `build_virtual_canvas_sdr`.
    let canvas = build_virtual_canvas_sdr()?;
    Ok(
        image::imageops::crop_imm(&canvas, region.x, region.y, region.width, region.height)
            .to_image(),
    )
}

/// Microphone + system loopback, mixed to the encoder's PCM format.
///
/// Holds zero, one or two open endpoints. Both are optional and both
/// degrade independently: losing the microphone must not cost the user
/// their system audio, and losing both must not cost them the video.
/// Both meters at rest. The reset value for [`AudioMixer::peaks`].
const SILENT_LEVELS: recorder::RecorderLevels = recorder::RecorderLevels {
    microphone: 0.0,
    system: 0.0,
};

struct AudioMixer {
    #[cfg(target_os = "windows")]
    sources: Vec<clippity_platform::windows::audio::AudioCapture>,
    /// Frames of stereo audio handed to the encoder so far. The audio
    /// timeline is derived from this count rather than the wall clock:
    /// the sample rate *is* the clock, and deriving timestamps from it
    /// is what keeps the track from drifting against the video.
    frames_written: u64,
    enabled: bool,
    /// Loudest sample each source produced since the meters were last
    /// read, held rather than sampled instantaneously.
    ///
    /// The meters are emitted at a tenth of the rate audio is polled, so
    /// reading only the packet that happens to coincide with an emit
    /// would miss most transients — a meter that misses the loud part is
    /// worse than no meter. `take_levels` drains this, so each reading
    /// covers exactly the interval since the last one.
    peaks: recorder::RecorderLevels,
}

impl AudioMixer {
    #[cfg(target_os = "windows")]
    fn open(request: &ValidatedRecorderRequest) -> Self {
        use clippity_platform::windows::audio::{AudioCapture, Direction};
        use clippity_platform::windows::media_foundation::AUDIO_SAMPLE_RATE;

        let mut sources = Vec::new();
        if request.audio.microphone {
            match AudioCapture::open(
                Direction::Microphone,
                request.audio.microphone_device.as_deref(),
                AUDIO_SAMPLE_RATE,
            ) {
                Ok(c) => sources.push(c),
                // Logged, not fatal: the recording proceeds without it
                // and `has_audio` on the result reports the truth.
                Err(e) => tracing::warn!("microphone unavailable, recording without it: {e}"),
            }
        }
        if request.audio.system {
            match AudioCapture::open(
                Direction::SystemLoopback,
                request.audio.system_device.as_deref(),
                AUDIO_SAMPLE_RATE,
            ) {
                Ok(c) => sources.push(c),
                Err(e) => tracing::warn!("system audio unavailable, recording without it: {e}"),
            }
        }
        let enabled = !sources.is_empty();
        Self {
            sources,
            frames_written: 0,
            enabled,
            peaks: SILENT_LEVELS,
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn open(_request: &ValidatedRecorderRequest) -> Self {
        Self {
            frames_written: 0,
            enabled: false,
            peaks: SILENT_LEVELS,
        }
    }

    /// Drain every endpoint, apply its gain, mix, and write one packet
    /// to the sink.
    #[cfg(target_os = "windows")]
    fn pump(
        &mut self,
        sink: &mut Box<dyn RecordingSink>,
        control: &SessionControl,
    ) -> AppResult<()> {
        use clippity_platform::windows::audio::Direction;
        use clippity_platform::windows::media_foundation::AUDIO_SAMPLE_RATE;
        use clippity_platform::windows::pcm;

        if !self.enabled || !sink.wants_audio() {
            return Ok(());
        }
        let mut mixed: Vec<f32> = Vec::new();
        for source in &mut self.sources {
            let which = match source.direction() {
                Direction::Microphone => recorder::AudioSource::Microphone,
                Direction::SystemLoopback => recorder::AudioSource::System,
            };
            let mut packet = source.drain();
            if packet.is_empty() {
                continue;
            }
            // Gain first, then meter: the number on screen has to be the
            // level going into the file, or a user pulling a slider down
            // would watch a meter that never moves.
            pcm::apply_gain(&mut packet, control.gain(which));
            let peak = pcm::peak(&packet);
            let slot = match which {
                recorder::AudioSource::Microphone => &mut self.peaks.microphone,
                recorder::AudioSource::System => &mut self.peaks.system,
            };
            *slot = slot.max(peak);
            pcm::mix_into(&mut mixed, &packet);
        }
        if mixed.is_empty() {
            return Ok(());
        }

        let frames = (mixed.len() / 2) as u64;
        let timestamp =
            recorder::hns_from_millis(self.frames_written * 1_000 / AUDIO_SAMPLE_RATE as u64);
        let duration = recorder::hns_from_millis(frames * 1_000 / AUDIO_SAMPLE_RATE as u64);
        let bytes = pcm::to_i16_bytes(&mixed);
        sink.write_audio(&bytes, timestamp, duration)?;
        self.frames_written += frames;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    fn pump(
        &mut self,
        _sink: &mut Box<dyn RecordingSink>,
        _control: &SessionControl,
    ) -> AppResult<()> {
        Ok(())
    }

    /// Drop whatever the endpoints have queued without writing it —
    /// used while paused.
    #[cfg(target_os = "windows")]
    fn discard(&mut self) {
        for source in &mut self.sources {
            let _ = source.drain();
        }
        // The meters go quiet with the recording. Leaving the last live
        // reading frozen on screen would claim a paused session is still
        // hearing something.
        self.peaks = SILENT_LEVELS;
    }

    #[cfg(not(target_os = "windows"))]
    fn discard(&mut self) {}

    /// The peaks accumulated since the last call, resetting them.
    ///
    /// Returns `None` when there is no audio at all, so a silent session
    /// emits no level events rather than a steady stream of zeroes to a
    /// HUD with no meters to put them in.
    fn take_levels(&mut self) -> Option<recorder::RecorderLevels> {
        if !self.enabled {
            return None;
        }
        Some(std::mem::replace(&mut self.peaks, SILENT_LEVELS))
    }

    /// Stop feeding audio after a mid-session failure.
    fn disable(&mut self) {
        self.enabled = false;
    }

    /// Whether an audio track was genuinely produced — the honest
    /// answer for `RecorderResult::has_audio`.
    fn captured_anything(&self) -> bool {
        self.enabled && self.frames_written > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::recorder::{RecorderTarget, RecorderToggles};

    fn request(format: RecorderFormat, target: RecorderTarget) -> ValidatedRecorderRequest {
        ValidatedRecorderRequest {
            target,
            region: Region {
                x: 0,
                y: 0,
                width: 640,
                height: 480,
            },
            window_id: None,
            format,
            fps: 30,
            max_height: recorder::RESOLUTION_SOURCE,
            audio: Default::default(),
            encoding: Default::default(),
            sources: Vec::new(),
            toggles: RecorderToggles::default(),
            output_dir: None,
            preset: None,
        }
    }

    /// Where a recorded frame's time actually goes, at this display's
    /// real size.
    ///
    /// A capture that cannot keep up does not fail, it just produces
    /// fewer frames — so the only way to find out *which* stage is slow
    /// is to time them separately against a real screen.
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "needs a desktop session; reports timings rather than asserting"]
    fn recorder_capture_stage_timings() {
        use clippity_platform::windows::media_foundation::ComThread;
        use clippity_platform::windows::nv12;
        use std::time::Instant;

        let _com = ComThread::init().expect("COM");

        let (min_x, min_y, vw, vh) = virtual_bounds().expect("virtual bounds");
        println!("virtual desktop: {vw}x{vh} at ({min_x}, {min_y})");

        let region = Region {
            x: 0,
            y: 0,
            width: vw,
            height: vh,
        };

        const RUNS: u32 = 5;
        let mean = |total: std::time::Duration| total / RUNS;

        // 1. Resolving which monitor the region is on.
        let mut bounds_total = std::time::Duration::ZERO;
        let mut lookup_total = std::time::Duration::ZERO;
        for _ in 0..RUNS {
            let t = Instant::now();
            let _ = virtual_bounds().expect("bounds");
            bounds_total += t.elapsed();

            let t = Instant::now();
            let _ = Monitor::from_point(min_x, min_y);
            lookup_total += t.elapsed();
        }
        println!("  virtual_bounds()      {:?}", mean(bounds_total));
        println!("  Monitor::from_point() {:?}", mean(lookup_total));

        // 2. The grab itself — one whole capture_frame call.
        let mut grab_total = std::time::Duration::ZERO;
        let mut frame = None;
        for _ in 0..RUNS {
            let t = Instant::now();
            let captured = capture_frame(region).expect("grab");
            grab_total += t.elapsed();
            frame = Some(captured);
        }
        let frame = frame.expect("a frame");
        println!(
            "  capture_frame()       {:?}   ({}x{}, {:.1} MiB RGBA)",
            mean(grab_total),
            frame.width(),
            frame.height(),
            frame.as_raw().len() as f64 / (1024.0 * 1024.0)
        );

        // 3. RGBA -> NV12, which every encoded frame pays.
        let mut nv12_buffer = vec![0u8; nv12::nv12_len(frame.width(), frame.height())];
        let mut convert_total = std::time::Duration::ZERO;
        for _ in 0..RUNS {
            let t = Instant::now();
            nv12::to_nv12(
                frame.as_raw(),
                &mut nv12_buffer,
                frame.width(),
                frame.height(),
                nv12::PixelOrder::Rgba,
            );
            convert_total += t.elapsed();
        }
        println!("  to_nv12()             {:?}", mean(convert_total));

        // 4. The source the recorder actually uses — a duplication held
        //    open across frames, which is the whole point.
        let mut source = FrameSource::open(region);
        match &source {
            FrameSource::Held { .. } => println!("\n  held duplication: available"),
            FrameSource::OneShot => println!("\n  held duplication: UNAVAILABLE (per-call grabs)"),
        }

        let mut recycle: Option<Vec<u8>> = None;
        let mut held_total = std::time::Duration::ZERO;
        let mut fresh = 0u32;
        let mut unchanged = 0u32;
        const HELD_RUNS: u32 = 60;
        for _ in 0..HELD_RUNS {
            let t = Instant::now();
            match source.next(region, recycle.take()) {
                Ok(Some(frame)) => {
                    fresh += 1;
                    recycle = Some(frame.pixels);
                }
                Ok(None) => unchanged += 1,
                Err(e) => panic!("held source failed: {e}"),
            }
            held_total += t.elapsed();
        }
        println!(
            "  held source           {:?}   ({fresh} fresh, {unchanged} unchanged of {HELD_RUNS})",
            held_total / HELD_RUNS
        );

        let per_frame = held_total / HELD_RUNS + mean(convert_total);
        println!(
            "\n  frame budget at 30 fps is 33ms\n  \
             was: {:?} grab + {:?} convert\n  \
             now: {:?} grab + {:?} convert = {:?}  -> {:.0} fps ceiling",
            mean(grab_total),
            mean(convert_total),
            held_total / HELD_RUNS,
            mean(convert_total),
            per_frame,
            1000.0 / per_frame.as_secs_f64().max(0.000_001) / 1000.0
        );
    }

    #[test]
    fn mode_labels_distinguish_the_targets_and_formats() {
        assert_eq!(
            mode_label(&request(RecorderFormat::Mp4, RecorderTarget::Fullscreen)),
            "Screen Recording"
        );
        assert_eq!(
            mode_label(&request(RecorderFormat::Mp4, RecorderTarget::Region)),
            "Recording"
        );
        // A GIF is a GIF whatever it was framed on — the extension and
        // the label should agree with each other.
        assert_eq!(
            mode_label(&request(RecorderFormat::Gif, RecorderTarget::Fullscreen)),
            "GIF"
        );
    }

    #[test]
    fn a_fresh_control_block_reports_recording() {
        let control = SessionControl::new(&Default::default());
        assert_eq!(control.snapshot().state, RecorderState::Recording);
        assert_eq!(control.snapshot().elapsed_ms, 0);
    }

    #[test]
    fn publishing_updates_both_the_snapshot_and_the_atomic() {
        let control = SessionControl::new(&Default::default());
        control.publish(RecorderStatus {
            state: RecorderState::Paused,
            elapsed_ms: 4_200,
            frames: 126,
            dropped: 1,
            bytes: 2_048,
        });
        assert_eq!(control.snapshot().state, RecorderState::Paused);
        assert_eq!(control.snapshot().frames, 126);
        assert_eq!(control.elapsed_ms.load(Ordering::Relaxed), 4_200);
    }

    #[test]
    fn a_control_block_starts_at_the_requested_levels() {
        let control = SessionControl::new(&recorder::AudioSelection {
            microphone_gain_pct: 140,
            system_gain_pct: 60,
            ..Default::default()
        });
        assert_eq!(control.gain(recorder::AudioSource::Microphone), 1.4);
        assert_eq!(control.gain(recorder::AudioSource::System), 0.6);
    }

    #[test]
    fn a_live_gain_change_is_clamped_like_a_stored_one() {
        let control = SessionControl::new(&Default::default());
        control.set_gain(recorder::AudioSource::Microphone, 9_000);
        assert_eq!(
            control.gain(recorder::AudioSource::Microphone),
            recorder::gain_scalar(recorder::GAIN_PCT_MAX)
        );
    }

    #[test]
    fn unmuting_restores_the_level_the_slider_was_at() {
        // The point of a mute button rather than dragging to zero: the
        // level survives the round trip.
        let control = SessionControl::new(&Default::default());
        control.set_gain(recorder::AudioSource::System, 40);
        control.set_muted(recorder::AudioSource::System, true);
        assert_eq!(control.gain(recorder::AudioSource::System), 0.0);
        control.set_muted(recorder::AudioSource::System, false);
        assert_eq!(control.gain(recorder::AudioSource::System), 0.4);
    }

    #[test]
    fn unmuting_a_source_that_was_already_silent_lands_on_unity() {
        // Otherwise the button would appear to do nothing.
        let control = SessionControl::new(&recorder::AudioSelection {
            microphone_gain_pct: 0,
            ..Default::default()
        });
        control.set_muted(recorder::AudioSource::Microphone, true);
        control.set_muted(recorder::AudioSource::Microphone, false);
        assert_eq!(
            control.gain(recorder::AudioSource::Microphone),
            recorder::gain_scalar(recorder::GAIN_PCT_DEFAULT)
        );
    }

    #[test]
    fn the_two_sources_have_independent_levels() {
        let control = SessionControl::new(&Default::default());
        control.set_muted(recorder::AudioSource::Microphone, true);
        assert_eq!(control.gain(recorder::AudioSource::Microphone), 0.0);
        assert_eq!(
            control.gain(recorder::AudioSource::System),
            recorder::gain_scalar(recorder::GAIN_PCT_DEFAULT)
        );
    }

    /// Records the real desktop for two seconds through the real
    /// encoder.
    ///
    /// This is the pipeline test: `xcap` region grab → `RgbaImage` →
    /// NV12 (channel order and all) → Media Foundation → a playable
    /// MP4 on disk. Everything the session loop does except the Tauri
    /// event plumbing, which needs an `AppHandle` a unit test can't
    /// mint. `#[ignore]`d because it needs a real desktop session and
    /// takes a couple of seconds.
    #[test]
    #[ignore = "needs a Windows desktop session; records for ~2s"]
    fn records_the_real_desktop_to_a_playable_mp4() {
        #[cfg(target_os = "windows")]
        let _com = clippity_platform::windows::media_foundation::ComThread::init().expect("COM");

        let dir = std::env::temp_dir().join(format!("clippity-rec-{}", next_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.mp4");

        // A 640×480 window onto whatever is on screen, at 15 fps.
        let mut req = request(RecorderFormat::Mp4, RecorderTarget::Region);
        req.fps = 15;
        let mut sink = sink::open(&path, req.format, sink::SinkConfig::for_recording(&req))
            .expect("mp4 sink opens");

        let fps = req.fps;
        let interval = Duration::from_millis(recorder::frame_interval_ms(fps));
        let mut frames = 0u64;
        let mut elapsed = 0u64;
        while elapsed < 2_000 {
            let frame = capture_frame(req.region).expect("desktop grab");
            assert_eq!(
                (frame.width(), frame.height()),
                (req.region.width, req.region.height),
                "the grab must match the requested region exactly"
            );
            sink.write_frame(
                SinkFrame::rgba(&frame),
                recorder::hns_from_millis(elapsed),
                recorder::frame_duration_hns(fps),
            )
            .expect("frame encodes");
            frames += 1;
            elapsed += interval.as_millis() as u64;
            std::thread::sleep(interval);
        }
        sink.finish().expect("finalize");

        let size = std::fs::metadata(&path).expect("file exists").len();
        assert!(frames >= 25, "expected ~30 frames, got {frames}");
        assert!(size > 10_000, "expected real video, got {size} bytes");

        let head = std::fs::read(&path).unwrap();
        assert_eq!(&head[4..8], b"ftyp", "not an MP4 container");
        println!("recorded {frames} frames, {size} bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_working_file_is_hidden_from_the_library_scan() {
        // The library skips dot-prefixed entries, which is what keeps an
        // in-progress (or crash-orphaned) recording from showing up as a
        // broken row.
        let name = format!(".clippity-recording-{}.mp4", next_id());
        assert!(name.starts_with('.'), "working file must be dot-prefixed");
        assert!(name.ends_with(".mp4"));
    }
}
