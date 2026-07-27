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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use image::RgbaImage;
use tauri::{AppHandle, Manager};
use xcap::Monitor;

use clippity_domain::metadata::CaptureSource;
use clippity_domain::overlay::Region;
use clippity_domain::recorder::{
    self, RecorderFormat, RecorderRequest, RecorderResult, RecorderState, RecorderStatus,
    RecorderStopReason, ValidatedRecorderRequest,
};
use clippity_infra::error::{AppError, AppResult};
use clippity_infra::events;

use crate::capture_io::{next_id, promote_capture_file, resolve_save_dir};
use crate::sidecar;
use crate::overlay_service::{build_virtual_canvas, monitor_for_regions, virtual_bounds};
use crate::settings_service::{
    CapturesDirSource, NameTemplateSource, RecordingSettingsSource,
};
use crate::window_service;

mod gif_sink;
mod mp4_sink;
mod sink;

use sink::RecordingSink;

/// How often the worker publishes a status tick to the HUD.
///
/// Once a second, not once a frame: the HUD shows whole seconds and a
/// frame counter, so a 60 fps recording emitting per frame would wake
/// the toast WebView sixty times to redraw the same "00:07".
const TICK_INTERVAL: Duration = Duration::from_millis(500);

/// Longest the worker will sleep in one go while paused or idle, so a
/// stop request is acted on promptly rather than after a whole frame
/// interval on a slow recording.
const CONTROL_POLL: Duration = Duration::from_millis(20);

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
}

impl SessionControl {
    fn new() -> Self {
        Self {
            stop: AtomicBool::new(false),
            discard: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            status: Mutex::new(RecorderStatus {
                state: RecorderState::Recording,
                ..RecorderStatus::idle()
            }),
            elapsed_ms: AtomicU64::new(0),
        }
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
                let _ = session.worker.join();
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
        let captures_dir = resolve_save_dir(
            validated.output_dir.as_deref(),
            self.captures.captures_dir(),
        );
        let template = self.naming.name_template();

        let control = Arc::new(SessionControl::new());
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

        let outcome = session.worker.join().map_err(|_| {
            AppError::Recorder("the recording worker stopped unexpectedly".into())
        })?;

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

    let mut sink = sink::open(&working, request)?;
    let mut audio = AudioMixer::open(request);

    let frame_interval = Duration::from_millis(recorder::frame_interval_ms(request.fps));
    let started = Instant::now();
    let mut last_instant = started;
    let mut recorded = Duration::ZERO;
    let mut next_frame = Instant::now();
    let mut last_tick = Instant::now();
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
        match capture_frame(request.region) {
            Ok(frame) => {
                let timestamp = recorder::hns_from_millis(elapsed_ms);
                let duration = recorder::frame_duration_hns(request.fps);
                if let Err(e) = sink.write_frame(&frame, timestamp, duration) {
                    failure = Some(e.to_string());
                    reason = RecorderStopReason::Failed;
                    break;
                }
                // Keep the very first frame as the library's poster. A
                // frame we already hold costs one PNG encode; the
                // alternative is opening a video decoder every time the
                // library draws a row.
                if frames == 0 {
                    poster = encode_poster(&frame);
                }
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
        if let Err(e) = audio.pump(&mut sink) {
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

        // --- pace ---
        next_frame += frame_interval;
        let now = Instant::now();
        if next_frame > now {
            std::thread::sleep((next_frame - now).min(frame_interval));
        } else {
            // Behind schedule: the encoder or the grab is slower than
            // the requested rate. Re-base rather than trying to catch
            // up, which would spin without ever recovering, and record
            // the miss so the user can lower the frame rate.
            dropped += 1;
            next_frame = now;
        }
    }

    let elapsed_ms = recorded.as_millis() as u64;
    let (width, height) = (request.region.width, request.region.height);
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

/// Encode a captured frame as the library's poster PNG.
///
/// Downscaled first: the library asks for a few hundred pixels wide, so
/// storing a full 4K frame per recording would cost more disk than some
/// of the recordings themselves.
fn encode_poster(frame: &RgbaImage) -> Option<Vec<u8>> {
    let (w, h) = (frame.width(), frame.height());
    if w == 0 || h == 0 {
        return None;
    }
    let scale = (POSTER_MAX_EDGE as f64 / w.max(h) as f64).min(1.0);
    let small = image::imageops::thumbnail(
        frame,
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

    let canvas = build_virtual_canvas()?;
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
struct AudioMixer {
    #[cfg(target_os = "windows")]
    sources: Vec<clippity_platform::windows::audio::AudioCapture>,
    /// Frames of stereo audio handed to the encoder so far. The audio
    /// timeline is derived from this count rather than the wall clock:
    /// the sample rate *is* the clock, and deriving timestamps from it
    /// is what keeps the track from drifting against the video.
    frames_written: u64,
    enabled: bool,
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
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn open(_request: &ValidatedRecorderRequest) -> Self {
        Self {
            frames_written: 0,
            enabled: false,
        }
    }

    /// Drain every endpoint, mix, and write one packet to the sink.
    #[cfg(target_os = "windows")]
    fn pump(&mut self, sink: &mut Box<dyn RecordingSink>) -> AppResult<()> {
        use clippity_platform::windows::media_foundation::AUDIO_SAMPLE_RATE;
        use clippity_platform::windows::pcm;

        if !self.enabled || !sink.wants_audio() {
            return Ok(());
        }
        let mut mixed: Vec<f32> = Vec::new();
        for source in &mut self.sources {
            let packet = source.drain();
            if !packet.is_empty() {
                pcm::mix_into(&mut mixed, &packet);
            }
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
    fn pump(&mut self, _sink: &mut Box<dyn RecordingSink>) -> AppResult<()> {
        Ok(())
    }

    /// Drop whatever the endpoints have queued without writing it —
    /// used while paused.
    #[cfg(target_os = "windows")]
    fn discard(&mut self) {
        for source in &mut self.sources {
            let _ = source.drain();
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn discard(&mut self) {}

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
            audio: Default::default(),
            toggles: RecorderToggles::default(),
            output_dir: None,
            preset: None,
        }
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
        let control = SessionControl::new();
        assert_eq!(control.snapshot().state, RecorderState::Recording);
        assert_eq!(control.snapshot().elapsed_ms, 0);
    }

    #[test]
    fn publishing_updates_both_the_snapshot_and_the_atomic() {
        let control = SessionControl::new();
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
        let mut sink = sink::open(&path, &req).expect("mp4 sink opens");

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
                &frame,
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
