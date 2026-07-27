//! Scrolling-Window recording session (ADR 0008).
//!
//! Manual-scroll, periodic-capture model: the user selects a region and
//! starts; a worker thread captures the region every [`RECORDING_TICK_MS`],
//! drops near-duplicate frames, and accumulates each new frame's
//! cumulative scroll offset incrementally. A throttled downscaled stitch
//! is emitted to the recording HUD as a live preview. On stop the frames
//! are stitched into one tall PNG and saved like any region capture.
//!
//! Recording ends one of two ways: the HUD's Stop & Stitch / Discard
//! buttons, or the worker detecting the scroll direction reversed — it
//! emits `recording/auto-stop`, which the HUD turns into a commit (ADR
//! 0008 follow-up #4). The reversing frame itself is discarded.
//!
//! The fullscreen overlay hides on start (it would block scrolling); the
//! HUD lives in the toast window, which the command excludes from capture
//! so it never lands in a frame.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use base64::Engine;
use image::{ImageFormat, RgbaImage};
use tauri::{AppHandle, Manager};

use clippity_infra::events;
use clippity_domain::metadata::CaptureSource;
use clippity_domain::overlay::{validate_region, OverlayResult, Region};
use clippity_domain::scroll::{self, ScrollAxis, ScrollDirection};
use clippity_infra::error::{AppError, AppResult};
use crate::capture_io::{copy_png_to_clipboard, next_id, save_capture_png};
use crate::overlay_service::{build_virtual_canvas, monitor_for_regions};
use crate::settings_service::{CapturesDirSource, NameTemplateSource};
use crate::window_service;

/// Worker capture cadence. Capturing more often means consecutive kept
/// frames overlap more, which both removes the risk of a fast scroll
/// outrunning the capture (leaving a gap in the stitch) and gives the
/// offset detector more shared content to lock onto. Still leaves a
/// whole-desktop grab + crop comfortable headroom.
const RECORDING_TICK_MS: u64 = 220;
/// Minimum gap between live-preview emits.
const PREVIEW_THROTTLE_MS: u64 = 300;
/// Longest edge of the live-preview thumbnail.
const PREVIEW_MAX_EDGE: u32 = 320;

// ---- Panoramic (auto-scroll) tuning ----
//
// The wheel step is NOT a fixed notch count: it's calibrated to the
// selected region's height (see `domain::scroll::calibrated_wheel_delta`).
// A fixed step that exceeds a short region's height makes consecutive
// frames non-overlapping, which `detect_offset` can't align — the stitch
// then collapses into an overlapping jumble (the single-`Box-row`
// failure). The worker starts at the responsive floor, measures the
// surface's pixels-per-wheel-unit from each step's detected offset, and
// re-sizes the step to advance ~`AUTO_STEP_ADVANCE_FRACTION` of the region.

/// Pause after a scroll step before capturing — lets the target finish
/// its (often animated/smooth) scroll so the frame isn't mid-motion.
const AUTO_SETTLE_MS: u64 = 260;
/// Consecutive no-change steps that mean the content can't scroll any
/// further — i.e. we've reached the end and should commit. Requiring a
/// few in a row rides out a single slow-to-render frame.
const AUTO_END_STAGNANT: u32 = 3;
/// Consecutive low-confidence steps (the step outran the region even after
/// halving toward the floor) that mean we can't keep this selection's
/// frames overlapping — commit what we have rather than loop or emit a
/// collapsed stitch. Only reachable for a region too short for even the
/// floor step to overlap.
const AUTO_MAX_LOST: u32 = 4;
/// Hard frame cap so an endlessly-animating surface (video, ticker)
/// can't grow the stitch without bound. Higher than the legacy 120 since
/// a short region now takes smaller (more numerous) steps per page.
const AUTO_MAX_FRAMES: u32 = 300;
/// Hard step cap (scroll attempts) regardless of frames appended — a
/// backstop for the case where capture keeps failing (no frame appended,
/// so `AUTO_MAX_FRAMES` never trips) so the worker can't loop forever.
const AUTO_MAX_STEPS: u32 = 600;

#[derive(serde::Serialize, Clone)]
struct TickPayload {
    frames: u32,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PreviewPayload {
    data_uri: String,
}

struct SessionData {
    frames: Vec<RgbaImage>,
    /// Cumulative offset of each frame (same length as `frames`).
    offsets: Vec<(i32, i32)>,
    last_preview: Instant,
}

struct ScrollSession {
    data: Mutex<SessionData>,
    stop: AtomicBool,
    region: Region,
    /// Scroll direction (Down/Up/Left/Right) — sets the stitch axis for
    /// both models, and which way the auto-scroll worker drives the wheel.
    direction: ScrollDirection,
    /// Panoramic mode: the worker drives the scroll itself (auto-scroll)
    /// instead of following the user. `false` = the legacy manual
    /// Scrolling-Window model.
    auto_scroll: bool,
    clipboard: bool,
    preview: bool,
    /// Cursor position (virtual-screen px) captured at start, restored
    /// on stop — the auto-scroll worker moves the cursor to drive the
    /// wheel, so we put it back where the user left it. `None` for the
    /// manual model (it never touches the cursor).
    restore_cursor: Option<(i32, i32)>,
    /// Title of the window focused when the recording began, for the
    /// saved file name. Often `None` (the overlay/Clippity is focused at
    /// that point), in which case the name falls back to the capture type.
    source_title: Option<String>,
    /// Display the recorded region sits on, resolved once at `start`.
    /// A stitch is many frames over many seconds, so there is no single
    /// instant to resolve it at later — and the region never moves during
    /// a recording, so the answer can't drift. `None` when display
    /// enumeration failed.
    source_monitor: Option<String>,
}

struct ActiveRecording {
    session: Arc<ScrollSession>,
    worker: JoinHandle<()>,
}

pub struct ScrollCaptureService {
    active: Mutex<Option<ActiveRecording>>,
    captures: Arc<dyn CapturesDirSource>,
    naming: Arc<dyn NameTemplateSource>,
}

impl ScrollCaptureService {
    pub fn new(captures: Arc<dyn CapturesDirSource>, naming: Arc<dyn NameTemplateSource>) -> Self {
        Self {
            active: Mutex::new(None),
            captures,
            naming,
        }
    }

    /// Begin a scroll recording: hide the overlay, capture the first
    /// frame, and spawn the worker. The caller (command) then shows the
    /// recording HUD. Errors if a recording is already running or the
    /// region is invalid.
    pub fn start(
        &self,
        app: &AppHandle,
        region: Region,
        direction: ScrollDirection,
        auto_scroll: bool,
        clipboard: bool,
        preview: bool,
    ) -> AppResult<()> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::Capture("scroll lock poisoned".into()))?;
        if active.is_some() {
            return Err(AppError::Capture(
                "a scroll recording is already in progress".into(),
            ));
        }

        // The window focused as the recording begins, for the file name.
        // Captured before the overlay hides; usually our own window (so
        // the namer falls back to the "Scrolling"/"Panoramic" type label).
        let source_title = foreground_window_title();
        // Which display the region sits on, resolved while the overlay's
        // coordinate space is still the current one.
        let source_monitor = monitor_for_regions(&[region]);

        // Hide the fullscreen overlay so the content beneath it is
        // scrollable / capturable; the recording HUD takes over (a small
        // toast). Manual mode: the user scrolls. Panoramic: the worker
        // scrolls.
        if let Some(overlay) = app.get_webview_window("overlay") {
            overlay.hide().map_err(AppError::from)?;
        }

        // Remember the cursor so the auto-scroll worker can restore it
        // after it's done driving the wheel (it has to move the pointer
        // over the target to scroll it).
        let restore_cursor = if auto_scroll {
            current_cursor_pos()
        } else {
            None
        };

        let first = capture_region(region)?;
        let session = Arc::new(ScrollSession {
            data: Mutex::new(SessionData {
                frames: vec![first],
                offsets: vec![(0, 0)],
                last_preview: Instant::now(),
            }),
            stop: AtomicBool::new(false),
            region,
            direction,
            auto_scroll,
            clipboard,
            preview,
            restore_cursor,
            source_title,
            source_monitor,
        });

        let worker = {
            let app = app.clone();
            let session = session.clone();
            std::thread::spawn(move || {
                if session.auto_scroll {
                    run_auto_worker(app, session);
                } else {
                    run_worker(app, session);
                }
            })
        };
        *active = Some(ActiveRecording { session, worker });
        Ok(())
    }

    /// Stop the recording: join the worker, restore Clippity's window,
    /// then stitch + save (unless `discard`). Returns the saved capture,
    /// or `None` when discarding or when nothing was recording.
    pub fn stop(&self, app: &AppHandle, discard: bool) -> AppResult<Option<OverlayResult>> {
        let recording = {
            let mut active = self
                .active
                .lock()
                .map_err(|_| AppError::Capture("scroll lock poisoned".into()))?;
            active.take()
        };
        let Some(recording) = recording else {
            return Ok(None);
        };

        // Signal stop and drain the in-flight tick before reading frames.
        recording.session.stop.store(true, Ordering::Relaxed);
        let _ = recording.worker.join();

        // Auto-scroll moved the cursor to drive the wheel — put it back
        // where the user left it (after the worker has fully stopped).
        if let Some((x, y)) = recording.session.restore_cursor {
            restore_cursor_pos(x, y);
        }

        // The capture is done — bring Clippity's window back.
        window_service::restore_window(app, "capture");

        if discard {
            return Ok(None);
        }

        let (frames, offsets) = {
            let mut data = recording
                .session
                .data
                .lock()
                .map_err(|_| AppError::Capture("scroll lock poisoned".into()))?;
            (
                std::mem::take(&mut data.frames),
                std::mem::take(&mut data.offsets),
            )
        };
        if frames.is_empty() {
            return Err(AppError::Capture("no frames captured".into()));
        }

        let stitched = scroll::stitch(&frames, &offsets);
        let (width, height) = (stitched.width(), stitched.height());
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(stitched)
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .map_err(|e| AppError::Capture(format!("png encode: {e}")))?;

        // Panoramic = app-driven auto-scroll; Scrolling = the manual model.
        let type_label = if recording.session.auto_scroll {
            "Panoramic"
        } else {
            "Scrolling"
        };
        // The stitched result is taller than any single frame, so the
        // recorded dimensions come from the stitch, not the source
        // window.
        let source = CaptureSource::from_mode(type_label)
            .with_window(recording.session.source_title.as_deref(), None)
            .with_size(width, height)
            .with_monitor(recording.session.source_monitor.as_deref());
        let path = save_capture_png(
            &self.captures.captures_dir(),
            &png,
            &self.naming.name_template(),
            &source,
        )?;
        if recording.session.clipboard {
            if let Err(e) = copy_png_to_clipboard(&png) {
                tracing::warn!("scroll clipboard copy failed: {e}");
            }
        }

        Ok(Some(OverlayResult {
            id: next_id(),
            width,
            height,
            path: path.to_string_lossy().into_owned(),
            preview: recording.session.preview,
        }))
    }
}

/// Capture the virtual desktop and crop the (clamped) region. Each tick
/// re-validates against the canvas, so a constant canvas yields
/// constant-size crops (required by the offset/dedup comparisons).
fn capture_region(region: Region) -> AppResult<RgbaImage> {
    let canvas = build_virtual_canvas()?;
    let r = validate_region(region, canvas.width(), canvas.height())
        .map_err(|e| AppError::Capture(e.into()))?;
    Ok(image::imageops::crop_imm(&canvas, r.x, r.y, r.width, r.height).to_image())
}

/// Worker loop: capture → dedup → detect offset → append (with cumulative
/// offset) → emit tick + throttled preview. Stops when the stop flag is
/// set (HUD buttons) or a detected direction reversal auto-commits — see
/// [`scroll::track_direction`].
fn run_worker(app: AppHandle, session: Arc<ScrollSession>) {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        // Capture (xcap/WGC) needs COM on this worker thread.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // The last *appended* frame is the dedup + offset reference; kept
    // local so the lock is never held across a capture/detect.
    let mut last = match session.data.lock() {
        Ok(d) => d.frames.last().cloned(),
        Err(_) => None,
    };
    let Some(mut last) = last.take() else {
        return;
    };

    // Locked scroll direction; the first deliberate step sets it and an
    // opposite step on the same axis auto-stops (the user scrolled back).
    let mut locked: Option<scroll::ScrollDir> = None;

    loop {
        if session.stop.load(Ordering::Relaxed) {
            break;
        }
        std::thread::sleep(Duration::from_millis(RECORDING_TICK_MS));
        if session.stop.load(Ordering::Relaxed) {
            break;
        }

        let frame = match capture_region(session.region) {
            Ok(f) => f,
            Err(_) => continue, // transient grab failure — try next tick
        };
        if scroll::frame_difference(&last, &frame) < scroll::FRAME_DEDUP_THRESHOLD {
            continue; // no meaningful scroll since the last kept frame
        }
        let axis = session.direction.axis();
        let (dx, dy) = scroll::detect_offset(&last, &frame, axis);

        // Auto-stop when the user scrolls back the way they came (ADR
        // 0008 follow-up #4). The reversing frame is *not* appended — we
        // commit what preceded it. The HUD hears this and runs the same
        // commit path as the Stop & Stitch button.
        let (new_locked, reversed) = scroll::track_direction(
            locked,
            dx,
            dy,
            frame.width(),
            frame.height(),
            axis == ScrollAxis::Horizontal,
        );
        if reversed {
            session.stop.store(true, Ordering::Relaxed);
            let _ = events::emit(&app, events::names::RECORDING_AUTO_STOP, ());
            break;
        }
        locked = new_locked;

        let (count, preview) = {
            let mut data = match session.data.lock() {
                Ok(d) => d,
                Err(_) => break,
            };
            let (px, py) = data.offsets.last().copied().unwrap_or((0, 0));
            data.offsets.push((px + dx, py + dy));
            data.frames.push(frame.clone());
            let count = data.frames.len() as u32;
            let preview =
                if data.last_preview.elapsed() >= Duration::from_millis(PREVIEW_THROTTLE_MS) {
                    data.last_preview = Instant::now();
                    preview_data_uri(&scroll::stitch(&data.frames, &data.offsets))
                } else {
                    None
                };
            (count, preview)
        };
        last = frame;

        let _ = events::emit(
            &app,
            events::names::RECORDING_TICK,
            TickPayload { frames: count },
        );
        if let Some(data_uri) = preview {
            let _ = events::emit(
                &app,
                events::names::RECORDING_PREVIEW,
                PreviewPayload { data_uri },
            );
        }
    }
}

/// Panoramic worker: drives the scroll itself instead of following the
/// user. Each step parks the cursor over the region and sends a wheel
/// scroll, waits for the surface to settle, captures, and appends the
/// new frame. Ends — committing what it has — when the view stops
/// changing for [`AUTO_END_STAGNANT`] steps (reached the bottom) or the
/// [`AUTO_MAX_FRAMES`] safety cap trips, both via the same
/// `recording/auto-stop` path the HUD already commits on. Also stops
/// promptly on the HUD's Stop / Discard (the `stop` flag).
fn run_auto_worker(app: AppHandle, session: Arc<ScrollSession>) {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    // Where to aim the wheel: the region's centre in virtual-screen
    // coordinates (canvas-local region + the desktop snapshot's origin).
    let origin = match crate::overlay_service::virtual_bounds() {
        Ok((min_x, min_y, _, _)) => (min_x, min_y),
        Err(_) => (0, 0),
    };
    let (anchor_x, anchor_y) = scroll::region_scroll_anchor(&session.region, origin);
    let axis = session.direction.axis();
    let horizontal = session.direction.is_horizontal();
    // The region's extent along the scroll axis — the budget each step's
    // advance must stay under to keep consecutive frames overlapping.
    let region_extent = match axis {
        ScrollAxis::Vertical => session.region.height,
        ScrollAxis::Horizontal => session.region.width,
    };

    let mut last = match session.data.lock() {
        Ok(d) => d.frames.last().cloned(),
        Err(_) => None,
    };
    let Some(mut last) = last.take() else {
        return;
    };

    // Adaptive wheel step (in WHEEL_DELTA units). Start at the responsive
    // floor so the first, un-calibrated step can't outrun a short region,
    // then grow toward a delta calibrated to advance
    // ~AUTO_STEP_ADVANCE_FRACTION of the region once a confident step has
    // measured the surface's pixels-per-unit.
    let mut delta = scroll::AUTO_WHEEL_DELTA_MIN;
    let mut px_per_unit: Option<f64> = None;

    let mut stagnant: u32 = 0;
    let mut lost: u32 = 0;
    let mut steps: u32 = 0;
    loop {
        if session.stop.load(Ordering::Relaxed) {
            break;
        }
        // Backstop: bound total scroll attempts so a persistent grab
        // failure (which appends no frame, so the frame cap never trips)
        // can't loop forever.
        steps += 1;
        if steps > AUTO_MAX_STEPS {
            session.stop.store(true, Ordering::Relaxed);
            let _ = events::emit(&app, events::names::RECORDING_AUTO_STOP, ());
            break;
        }

        // Drive one scroll step in the chosen direction, then let the
        // surface settle before grabbing. `wheel_notches` carries the
        // direction's sign; `delta` is the adaptive magnitude.
        let signed = session.direction.wheel_notches(delta);
        auto_scroll_step(anchor_x, anchor_y, horizontal, signed);
        std::thread::sleep(Duration::from_millis(AUTO_SETTLE_MS));
        if session.stop.load(Ordering::Relaxed) {
            break;
        }

        let frame = match capture_region(session.region) {
            Ok(f) => f,
            Err(_) => continue, // transient grab failure — try next step
        };

        // No meaningful change after a scroll = nothing left to scroll.
        // A few in a row confirms the end (rides out one slow frame). At the
        // floor step a real scroll always clears the dedup threshold, so
        // stagnation means the surface can't advance — not a too-small step.
        if scroll::frame_difference(&last, &frame) < scroll::FRAME_DEDUP_THRESHOLD {
            stagnant += 1;
            if stagnant >= AUTO_END_STAGNANT {
                session.stop.store(true, Ordering::Relaxed);
                let _ = events::emit(&app, events::names::RECORDING_AUTO_STOP, ());
                break;
            }
            continue;
        }

        // Offset along the scroll axis (cross axis pinned 0) + a verdict on
        // whether the frames actually overlapped.
        let (dx, dy, confident) = scroll::detect_offset_confident(&last, &frame, axis);

        // The step outran the region (no overlap to align). Undo it, halve
        // the step toward the floor, and retry from the same position
        // rather than commit a mis-aligned frame that collapses the stitch.
        // If even the floor can't keep overlap, commit what we have.
        if !confident {
            auto_scroll_step(anchor_x, anchor_y, horizontal, -signed);
            std::thread::sleep(Duration::from_millis(AUTO_SETTLE_MS));
            delta = (delta / 2).max(scroll::AUTO_WHEEL_DELTA_MIN);
            lost += 1;
            if lost >= AUTO_MAX_LOST {
                session.stop.store(true, Ordering::Relaxed);
                let _ = events::emit(&app, events::names::RECORDING_AUTO_STOP, ());
                break;
            }
            continue;
        }
        lost = 0;
        stagnant = 0;

        // Calibrate pixels-per-wheel-unit from the measured advance, then
        // re-size the step toward the overlap target — growing at most 2×
        // per step so a calibration jump can't itself overshoot.
        let advance = match axis {
            ScrollAxis::Vertical => dy.unsigned_abs(),
            ScrollAxis::Horizontal => dx.unsigned_abs(),
        };
        if advance > 0 {
            let measured = advance as f64 / delta as f64;
            let ppu = match px_per_unit {
                Some(p) => 0.5 * p + 0.5 * measured,
                None => measured,
            };
            px_per_unit = Some(ppu);
            let target = scroll::calibrated_wheel_delta(region_extent, ppu);
            delta = target
                .min(delta.saturating_mul(2))
                .max(scroll::AUTO_WHEEL_DELTA_MIN);
        }

        let (count, preview) = {
            let mut data = match session.data.lock() {
                Ok(d) => d,
                Err(_) => break,
            };
            let (px, py) = data.offsets.last().copied().unwrap_or((0, 0));
            data.offsets.push((px + dx, py + dy));
            data.frames.push(frame.clone());
            let count = data.frames.len() as u32;
            let preview =
                if data.last_preview.elapsed() >= Duration::from_millis(PREVIEW_THROTTLE_MS) {
                    data.last_preview = Instant::now();
                    preview_data_uri(&scroll::stitch(&data.frames, &data.offsets))
                } else {
                    None
                };
            (count, preview)
        };
        last = frame;

        let _ = events::emit(
            &app,
            events::names::RECORDING_TICK,
            TickPayload { frames: count },
        );
        if let Some(data_uri) = preview {
            let _ = events::emit(
                &app,
                events::names::RECORDING_PREVIEW,
                PreviewPayload { data_uri },
            );
        }

        // Safety cap: an endlessly-animating surface never goes stagnant,
        // so bound the stitch height and commit what we have.
        if count >= AUTO_MAX_FRAMES {
            session.stop.store(true, Ordering::Relaxed);
            let _ = events::emit(&app, events::names::RECORDING_AUTO_STOP, ());
            break;
        }
    }
}

/// One auto-scroll step (move cursor + wheel in the chosen direction).
/// `units` is the signed wheel delta in `WHEEL_DELTA` units; `horizontal`
/// picks the wheel axis. Windows-backed; a no-op elsewhere so the worker
/// compiles cross-platform.
fn auto_scroll_step(x: i32, y: i32, horizontal: bool, units: i32) {
    #[cfg(target_os = "windows")]
    clippity_platform::windows::input::auto_scroll_step(x, y, horizontal, units);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, horizontal, units);
    }
}

/// Current cursor position (virtual-screen px), or `None` off Windows /
/// on query failure.
fn current_cursor_pos() -> Option<(i32, i32)> {
    #[cfg(target_os = "windows")]
    {
        clippity_platform::windows::input::cursor_pos()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// The focused window's title for file naming, or `None` (no foreground
/// window, blank title, or our own window). Windows-only.
fn foreground_window_title() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        clippity_platform::windows::enumeration::foreground_window_title()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Restore the cursor to a saved position.
fn restore_cursor_pos(x: i32, y: i32) {
    #[cfg(target_os = "windows")]
    clippity_platform::windows::input::move_cursor(x, y);
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y);
    }
}

/// Downscale a stitched image to `PREVIEW_MAX_EDGE` and base64-encode it
/// as a PNG data URI for the HUD. `None` if encoding fails.
fn preview_data_uri(stitched: &RgbaImage) -> Option<String> {
    let longest = stitched.width().max(stitched.height());
    let small = if longest > PREVIEW_MAX_EDGE {
        let scale = PREVIEW_MAX_EDGE as f64 / longest as f64;
        let w = ((stitched.width() as f64 * scale).round() as u32).max(1);
        let h = ((stitched.height() as f64 * scale).round() as u32).max(1);
        image::imageops::thumbnail(stitched, w, h)
    } else {
        stitched.clone()
    };
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(small)
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    ))
}
