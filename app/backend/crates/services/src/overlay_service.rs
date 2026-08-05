//! Overlay orchestration. Owns the snapshot + finalize pipeline shared
//! by every overlay mode:
//!
//! 1. **show**: hide other primary windows → sleep the overlay
//!    compositor-unpaint → snapshot the entire virtual desktop into
//!    a cached `RgbaImage` → position the pre-declared `overlay`
//!    window at virtual-desktop bounds → show + focus →
//!    emit `clippity://overlay/shown`.
//! 2. **finalize** (`finish_region` / `finish_freehand` /
//!    `finish_multi_area`): take the cached canvas → run the mode's
//!    crop/mask/stitch (optionally compositing the cursor) → PNG-encode
//!    → save to the captures dir → optionally write to the clipboard →
//!    restore the previous primary window → emit
//!    `clippity://capture/finished`. All three share the private
//!    `finalize` lifecycle helper (ADR 0005).
//! 3. **pick_color**: sample one pixel from the cached snapshot, copy
//!    the hex to the clipboard, restore the window — no PNG, no
//!    `capture/finished` (the Color-Picker mode).
//! 4. **cancel**: hide the overlay window, restore the previous primary
//!    window, drop the cached canvas. No PNG produced.
//!
//! Modes still without an implementation (Object / Grab-Text /
//! Scrolling / Panoramic / Palette / Asset-Extract / Change-Detection)
//! reject at the `begin_region_capture` command guard until their ports
//! land.

use std::io::Cursor;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, RgbaImage};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use xcap::Monitor;

use crate::capture_io::{
    copy_rgba_to_clipboard, copy_text_to_clipboard, next_id, resolve_save_dir, save_capture_png,
    thumbnail_data_uri,
};
use crate::last_region_store::LastRegionStore;
use crate::settings_service::{CapturesDirSource, NameTemplateSource};
use crate::window_service::{self, CompositorWait};
use clippity_domain::enhance;
use clippity_domain::library::AuxColor;
use clippity_domain::metadata::{self, CaptureSource};
use clippity_domain::overlay::{
    point_in_polygon, polygon_bounds, resolve_last_region, validate_region, BrushMask,
    FinishBrushRequest, FinishFreehandRequest, FinishMultiAreaRequest, FinishRegionRequest,
    OverlayMode, OverlayResult, OverlayToggles, OverlayWindow, Region, MULTI_AREA_GAP_PX,
};
use clippity_domain::palette;
use clippity_domain::toast::PickedColor;
use clippity_domain::window_attribution::{self, MonitorRect, Rect as AttributionRect, WindowRect};
use clippity_infra::error::{AppError, AppResult};
use clippity_infra::events;

/// Longest-edge cap (physical px) for the Palette-Capture toast preview
/// thumbnail. Small — it's a 12×12-rem swatch source, not the artifact.
const PALETTE_PREVIEW_MAX_EDGE: u32 = 96;

/// What a mode's crop/mask/stitch produced, before it becomes a file.
///
/// Deliberately the decoded image rather than encoded PNG bytes: the
/// optional Smart-enhance pass and the PNG encode then live in exactly
/// one place ([`OverlayService::persist_and_emit`]) instead of being
/// duplicated — and forgettable — in every mode's producer. It also lets
/// the clipboard copy skip a full PNG decode of the bytes we just wrote.
struct ProducedOverlayCapture {
    image: RgbaImage,
    attribution_regions: Vec<Region>,
}

/// One display of the snapshotted desktop, rebased onto the canvas.
/// `name` is already the label the record stores
/// (`domain::metadata::monitor_label`), so `finalize` only has to pick a
/// winner — the formatting decision doesn't travel with the session.
#[derive(Clone, Debug)]
struct SessionMonitor {
    name: String,
    rect: Region,
}

/// Per-process overlay state — the cached snapshot stays alive from
/// `show` until either `finish` or `cancel` consumes it. Holding it
/// in the service (vs. on `AppState` as a sibling field) keeps the
/// state unreachable from outside the service.
#[derive(Default)]
pub struct OverlayState {
    /// Pre-overlay desktop snapshot (cursor-free). `finish_region`
    /// crops this so the result is guaranteed clean of overlay
    /// chrome.
    ///
    /// Behind an `Arc` because three consumers want the same pixels and
    /// none of them mutate: the session (until finalize), the loupe
    /// encoder thread, and Object mode's detector. A full-desktop RGBA
    /// buffer is 8 MiB at 1920×1200 and 33 MiB at 4K, so handing each one
    /// its own copy put a memcpy on the open path for no benefit.
    canvas: Option<Arc<RgbaImage>>,
    /// Top-left of `canvas` in virtual-screen physical pixels. Used
    /// for cursor compositing's `(origin_x, origin_y)` arg so the
    /// system cursor lands at the right place when not pinned.
    origin: (i32, i32),
    /// PNG bytes of the cached snapshot — the SAME cursor-free pixels as
    /// `canvas`, so the overlay's backdrop and the loupe's RGB readout
    /// both match what `finalize` will actually crop. The cursor, when
    /// the user asked for one, is composited at finalize against
    /// `cursor_pin`, not here.
    ///
    /// **Bytes, not a base64 data URI.** The overlay fetches these over
    /// the `clippity-snapshot` URI scheme instead of receiving them as a
    /// command result. A full-desktop PNG is ~8 MiB, which as a data URI
    /// became an 11 MiB JSON string to serialize, ship and `atob` before
    /// the webview could decode it — and it was then decoded three times
    /// over, once per `url(…)` consumer. Behind an `Arc` so the protocol
    /// handler can answer without holding the state lock across the
    /// response.
    snapshot_png: Option<Arc<Vec<u8>>>,
    /// Identifies the current snapshot in its URL, so a new session's
    /// pixels can never be served from the webview's cache for the
    /// previous session's URL — and so that *within* a session the three
    /// consumers share one cached decode. Monotonic; never reused.
    snapshot_id: u64,
    /// Label of the primary window that was visible immediately
    /// before `show` ran. `finish_region` and `cancel` restore that
    /// label so the user lands back on the window they came from
    /// (capture vs. dashboard) rather than always returning to
    /// "capture".
    previous_primary: Option<String>,
    /// Capturable top-level windows, captured at `show` time and frozen
    /// for the session (same instant as `canvas`). Front-to-back Z-order,
    /// in canvas-local coords. Served to the overlay frontend only in
    /// Window mode, but retained privately for Region/Freehand/Multi-Area
    /// filename attribution.
    windows: Vec<OverlayWindow>,
    /// The displays making up the snapshot, in canvas-local coords —
    /// captured at `show` alongside `windows` and for the same reason:
    /// resolving them at `finalize` would mean re-enumerating hardware
    /// after the desktop may already have changed. `finalize` attributes
    /// the capture rect against these to record which screen it came
    /// from.
    monitors: Vec<SessionMonitor>,
    /// Optional per-session save-dir override from a preset's "save to".
    /// Stashed at `show`, consumed at `finish_region`, cleared at
    /// `cancel`. `None` = the live captures dir. See ADR 0004.
    output_dir: Option<String>,
    /// Name of the preset that opened this overlay, if any — the same
    /// stash-at-`show` / consume-at-`finalize` lifetime as `output_dir`,
    /// because the capture it describes happens several IPC calls later.
    preset: Option<String>,
    /// Title of the window that was focused when the overlay opened —
    /// captured at `show` (before we hide our own chrome) and used as a
    /// filename fallback if window enumeration is unavailable. `None`
    /// when the overlay was opened from Clippity's own UI.
    source_title: Option<String>,
    /// The mode this overlay session opened in — sets the capture-type
    /// label for the file name at `finalize` (Region / Window / Freehand
    /// / Multi-Area). `None` between sessions.
    mode: Option<OverlayMode>,
}

pub struct OverlayService {
    captures: Arc<dyn CapturesDirSource>,
    naming: Arc<dyn NameTemplateSource>,
    /// Remembered last rectangular selection — written by every
    /// rect-shaped finalize, read by `last_region` (overlay restore) and
    /// `recapture_last` (the one-shot repeat).
    last_region: Arc<LastRegionStore>,
    /// Arc so the loupe-encoder thread spawned by `show` can mutate
    /// the cached `snapshot_png` without contending with command
    /// threads on a non-shared lock.
    state: Arc<Mutex<OverlayState>>,
    /// Whether every Clippity window is excluded from screen capture
    /// (`WDA_EXCLUDEFROMCAPTURE`, set once at startup). When true the
    /// snapshot is clean of our chrome no matter what is on screen, so
    /// `show` skips the hide-then-wait-for-the-compositor settle. False
    /// on older Windows (pre-2004) and non-Windows, where the settle is
    /// still the guard against capturing our own window.
    capture_shielded: AtomicBool,
}

impl OverlayService {
    pub fn new(
        captures: Arc<dyn CapturesDirSource>,
        naming: Arc<dyn NameTemplateSource>,
        last_region: Arc<LastRegionStore>,
    ) -> Self {
        Self {
            captures,
            naming,
            last_region,
            state: Arc::new(Mutex::new(OverlayState::default())),
            // Assume unshielded until startup proves otherwise, so a
            // build that never calls `set_capture_shielded` keeps the
            // safe hide-and-wait behaviour.
            capture_shielded: AtomicBool::new(false),
        }
    }

    /// Record whether the capture shield (`WDA_EXCLUDEFROMCAPTURE` on
    /// every window) was successfully applied at startup. Set once from
    /// `setup()`; read by `show` to decide whether it can skip the
    /// compositor settle.
    pub fn set_capture_shielded(&self, shielded: bool) {
        self.capture_shielded.store(shielded, Ordering::Relaxed);
    }

    /// Whether the capture shield applied. Reported in Settings →
    /// Advanced: when it didn't, the app's own windows can land in a
    /// capture, which is exactly the symptom a user would otherwise
    /// describe as "my screenshot has Clippity in it".
    pub fn capture_shielded(&self) -> bool {
        self.capture_shielded.load(Ordering::Relaxed)
    }

    /// The remembered region resolved against the CURRENT virtual
    /// desktop, or `None` when nothing is remembered / it no longer
    /// fits. `strict` refuses a region taken on a differently-sized
    /// canvas — see [`resolve_last_region`].
    pub fn last_region(&self, strict: bool) -> Option<Region> {
        let last = self.last_region.get()?;
        let (_, _, vw, vh) = virtual_bounds().ok()?;
        resolve_last_region(last, vw, vh, strict).ok()
    }

    /// Record `rect` as the last rectangular selection. Called from every
    /// finalize that crops an axis-aligned rect the user actually dragged
    /// — the shapes a "same spot again" repeat can reproduce. Freehand /
    /// Pen / Brush deliberately do not, since their bounding box is not
    /// what the user selected.
    fn remember_region(&self, rect: Region, canvas_w: u32, canvas_h: u32) {
        self.last_region.remember(rect, canvas_w, canvas_h);
    }

    /// Open the overlay for `mode`. Positions the pre-declared
    /// overlay window, captures the virtual desktop, shows the overlay,
    /// then prepares the loupe snapshot and emits `clippity://overlay/shown`.
    pub fn show(
        &self,
        app: &AppHandle,
        mode: OverlayMode,
        output_dir: Option<String>,
        preset: Option<String>,
    ) -> AppResult<()> {
        // Span the overlay across the full virtual desktop (all monitors).
        let (min_x, min_y, vw, vh) = virtual_bounds()?;

        // The overlay window is pre-declared in tauri.conf.json (creating
        // a window from a command thread is unreliable on Windows). Move
        // and size it while still hidden so reveal is as close to instant
        // as possible once the desktop snapshot exists.
        let overlay = app
            .get_webview_window("overlay")
            .ok_or_else(|| AppError::Overlay("overlay window missing from tauri config".into()))?;
        overlay
            .set_position(tauri::PhysicalPosition::new(min_x, min_y))
            .map_err(AppError::from)?;
        overlay
            .set_size(tauri::PhysicalSize::new(vw, vh))
            .map_err(AppError::from)?;
        overlay.set_always_on_top(true).map_err(AppError::from)?;

        // Remember which primary window was visible so we can restore
        // it after the overlay closes. If both are visible (shouldn't
        // be — the single-primary-window invariant is enforced
        // elsewhere), prefer the capture window since the overlay is
        // usually invoked from there.
        let previous_primary = window_service::current_visible_primary(app).map(str::to_string);
        // Capture the focused window's title now, before we hide our own
        // chrome — afterwards the foreground is ours (or nothing) and the
        // namer would discard it. `finalize` uses it only as a fallback
        // when window enumeration cannot attribute the selected pixels.
        let source_title = foreground_window_title();
        if let Ok(mut s) = self.state.lock() {
            s.previous_primary = previous_primary;
            // Stash the preset's save-dir override and its name (if any)
            // for the session; `finalize` consumes them, `cancel` clears
            // them.
            s.output_dir = output_dir;
            s.preset = preset;
            s.source_title = source_title;
            s.mode = Some(mode);
        }

        // Hide every other primary window (the capture window, mostly) so
        // the single-primary-window invariant holds and finalize can
        // restore the one the user came from.
        //
        // Whether we then WAIT before grabbing depends on the capture
        // shield. With it, every Clippity window is excluded from capture
        // (`WDA_EXCLUDEFROMCAPTURE`), so the snapshot can't contain our
        // chrome even while the hide is still in flight — the grab starts
        // immediately, which is the bulk of the open-latency win. Without
        // it (pre-2004 Windows, or the flag was refused) we fall back to
        // `settle_after_hide`, which waits for the hide to actually land
        // before the compositor settle, so a ghost frame of the capture
        // window can't bake into the crop.
        let hidden_count = window_service::hide_primary_windows(app, "overlay");
        if hidden_count > 0 && !self.capture_shielded.load(Ordering::Relaxed) {
            window_service::settle_after_hide(app);
        }

        // Snapshot the desktop BEFORE the overlay is visible so the
        // final crop stays clean of overlay UI. Cache the raw
        // cursor-free canvas now; the loupe's PNG is encoded on a
        // background thread (see below) so the visible handoff doesn't
        // wait on compression.
        // failure is logged but non-fatal — the overlay still opens.
        let mut loupe_canvas = None;
        let cursor_position = cursor_canvas_position(min_x, min_y, vw, vh);
        let snapshot_ok = match build_virtual_canvas() {
            Ok(canvas) => {
                // One buffer, two holders — the session and the encoder
                // thread — rather than a full-desktop memcpy per holder.
                let canvas = Arc::new(canvas);
                if let Ok(mut s) = self.state.lock() {
                    s.canvas = Some(Arc::clone(&canvas));
                    s.origin = (min_x, min_y);
                    s.snapshot_png = None;
                    s.snapshot_id += 1;
                }
                loupe_canvas = Some(canvas);
                true
            }
            Err(e) => {
                tracing::warn!("overlay snapshot failed: {e}");
                if let Ok(mut s) = self.state.lock() {
                    s.canvas = None;
                    s.origin = (min_x, min_y);
                    s.snapshot_png = None;
                    s.snapshot_id += 1;
                }
                false
            }
        };

        // Enumerate capturable top-level windows now — our primary
        // windows are hidden and the overlay isn't shown yet, so none of
        // our own chrome is in the list — rebased onto the snapshot
        // canvas. Window mode uses this for hover/click selection; other
        // file-producing modes use it privately to name the capture after
        // the visible window that dominates the selected area.
        let windows = gather_windows(min_x, min_y, vw, vh, mode);
        // The displays behind the same snapshot, rebased the same way.
        // Frozen here rather than resolved at finalize for the reason
        // the window list is: by then the overlay is gone and the desk
        // may have changed underneath us.
        let monitors = gather_monitors(min_x, min_y, vw, vh);
        if let Ok(mut s) = self.state.lock() {
            s.windows = windows;
            s.monitors = monitors;
        }

        // Spawn the loupe-PNG encode now so it runs in parallel with
        // `overlay.show()`. The thread emits OVERLAY_SNAPSHOT_READY
        // once the bytes land in state — the frontend listens for that
        // and loads them over the `clippity-snapshot` scheme. Decoupling
        // from OVERLAY_SHOWN lets the rest of the overlay UI become
        // interactive before the (expensive) encode finishes. Skipped
        // for Window mode, which never samples loupe pixels.
        // The loupe is for pixel-precise drag modes; the click-to-pick
        // window modes use the live cursor and a frame highlight instead.
        if let Some(canvas) = loupe_canvas
            .filter(|_| !matches!(mode, OverlayMode::Window | OverlayMode::RecordWindow))
        {
            let state_for_thread = Arc::clone(&self.state);
            let app_for_thread = app.clone();
            std::thread::spawn(move || {
                let png = render_loupe_png(&canvas);
                let ready = png.is_some();
                if let Ok(mut s) = state_for_thread.lock() {
                    s.snapshot_png = png.map(Arc::new);
                }
                if ready {
                    let _ =
                        events::emit(&app_for_thread, events::names::OVERLAY_SNAPSHOT_READY, ());
                }
            });
        }

        events::emit(
            app,
            events::names::OVERLAY_OPENING,
            OverlayOpeningPayload {
                mode,
                cursor_position,
            },
        )?;

        overlay.show().map_err(AppError::from)?;
        overlay.set_focus().map_err(AppError::from)?;

        // Notify the overlay so it (re)loads the snapshot reliably
        // even if the focus event is missed. Payload tells it which
        // interaction model to render. The snapshot data URI may not
        // be ready yet — the frontend's mount-time fetch handles the
        // race (snapshot returns None until the encoder thread lands
        // it), and OVERLAY_SNAPSHOT_READY catches the late case.
        events::emit(
            app,
            events::names::OVERLAY_SHOWN,
            OverlayShownPayload { snapshot_ok, mode },
        )?;
        Ok(())
    }

    /// Hide the overlay window without consuming the cached canvas
    /// (the canvas is still useful if the next overlay session opens
    /// without a fresh snapshot — but we drop it here so subsequent
    /// sessions always rebuild). Restores whichever primary window
    /// was visible when `show` ran.
    pub fn cancel(&self, app: &AppHandle) -> AppResult<()> {
        let previous = self.dismiss(app)?;
        window_service::restore_window(app, previous.as_deref().unwrap_or("capture"));
        Ok(())
    }

    /// Hide the overlay and clear the session, **handing back** which
    /// primary window was visible when `show` ran instead of restoring
    /// it.
    ///
    /// [`Self::cancel`] split in two, for a session that *takes over*
    /// from the overlay rather than ending with it — a recording (ADR
    /// 0031). Such a session must dismiss the overlay immediately, or it
    /// stays on screen swallowing clicks and the user reads it as still
    /// selecting. But it must **not** put the capture window back yet:
    /// the user is about to record that screen, and the window
    /// reappearing over it is precisely what getting it out of the way
    /// was for. The recorder restores this label when the session ends.
    ///
    /// Returns `None` when no overlay session was open, so a caller that
    /// can be reached both from the overlay and directly (the recorder
    /// is) may call it unconditionally.
    pub fn dismiss(&self, app: &AppHandle) -> AppResult<Option<String>> {
        let was_open = app
            .get_webview_window("overlay")
            .map(|overlay| {
                let visible = overlay.is_visible().unwrap_or(false);
                if visible {
                    let _ = overlay.hide();
                }
                visible
            })
            .unwrap_or(false);
        // Cleared unconditionally — this is also the recovery path, and
        // leaving a half-session behind because the window happened to
        // be down already is how a stale canvas reaches the next open.
        // Drop the cached canvas: next `show` will rebuild.
        let previous = if let Ok(mut s) = self.state.lock() {
            s.canvas = None;
            s.snapshot_png = None;
            s.windows.clear();
            s.monitors.clear();
            s.output_dir = None;
            s.preset = None;
            s.source_title = None;
            s.mode = None;
            s.previous_primary.take()
        } else {
            None
        };
        // The label is reported only when a session was genuinely on
        // screen. That visibility check *is* the "did the overlay hide a
        // window for me?" question, and answering it from stale state
        // would have the recorder restore a window it never hid.
        Ok(was_open.then_some(previous).flatten())
    }

    /// Switch the active selection method on the *current* session
    /// without re-snapshotting. The Region-family methods (Rectangle /
    /// Freehand / Pen / Magnetic Lasso / Brush) all operate on the same
    /// cached desktop snapshot, so the overlay's method dropdown swaps
    /// them in place; only the session `mode` needs updating so the
    /// file-name label (see `type_label_for`) matches what the user
    /// actually drew. No-op (Ok) when no session is open.
    pub fn set_mode(&self, mode: OverlayMode) -> AppResult<()> {
        if let Ok(mut s) = self.state.lock() {
            if s.mode.is_some() {
                s.mode = Some(mode);
            }
        }
        Ok(())
    }

    /// Finalize a Region-mode capture. Crops the cached canvas (or
    /// falls back to a live capture if no canvas), composites the
    /// cursor if requested, saves the PNG, emits
    /// `clippity://capture/finished`, returns the result.
    pub fn finish_region(
        &self,
        app: &AppHandle,
        request: FinishRegionRequest,
    ) -> AppResult<OverlayResult> {
        self.finalize(app, request.toggles, None, |canvas, origin| {
            // Validate against the canvas we'll actually crop (frontend
            // clamps, but the backend never trusts client coords).
            let region = validate_region(request.rect, canvas.width(), canvas.height())
                .map_err(|e| AppError::Overlay(e.into()))?;
            // Remember the validated (clamped) rect, not the raw request —
            // a later repeat should reproduce the pixels we actually
            // cropped, not the coordinates the client asked for.
            self.remember_region(region, canvas.width(), canvas.height());
            let image = crop_with_optional_cursor(
                canvas,
                region,
                origin,
                request.toggles.cursor,
                request.cursor_pin,
            )?;
            Ok(ProducedOverlayCapture {
                image,
                attribution_regions: vec![region],
            })
        })
    }

    /// Finalize a Fullscreen capture taken from inside the overlay (the
    /// `F` keybind / Fullscreen tab). Crops the monitor the cursor is on
    /// out of the cached snapshot rather than re-grabbing the screen, so
    /// the saved pixels are exactly the frozen backdrop the user was
    /// looking at — no window-hide dance, no chance of catching our own
    /// chrome.
    ///
    /// Deliberately does NOT `remember_region`: the user didn't drag this
    /// rect, and clobbering their remembered selection with a whole
    /// monitor would make the next "repeat last region" a surprise.
    pub fn finish_fullscreen(
        &self,
        app: &AppHandle,
        toggles: OverlayToggles,
    ) -> AppResult<OverlayResult> {
        // Resolve the target monitor BEFORE finalize hides the overlay:
        // once the overlay goes away the cursor may land on a different
        // window, and `finalize` has already consumed the session by the
        // time `produce` runs.
        let target = monitor_rect_under_cursor()?;
        self.finalize(app, toggles, Some("Fullscreen"), |canvas, origin| {
            let region = rect_on_canvas(target, origin, canvas.width(), canvas.height())?;
            // No cursor pin — the whole monitor is in frame, so the
            // cursor's live position is already correct (same as the
            // non-overlay fullscreen pipeline).
            let image = crop_with_optional_cursor(canvas, region, origin, toggles.cursor, None)?;
            Ok(ProducedOverlayCapture {
                image,
                attribution_regions: vec![region],
            })
        })
    }

    /// Finalize a Freehand-mode (lasso) capture: mask everything outside
    /// the drawn polygon to transparent, crop to the path's bounding box.
    /// Shares the Region finalize lifecycle (ADR 0005).
    pub fn finish_freehand(
        &self,
        app: &AppHandle,
        request: FinishFreehandRequest,
    ) -> AppResult<OverlayResult> {
        self.finalize(app, request.toggles, None, |canvas, origin| {
            let attribution_region =
                freehand_attribution_region(&request.points, canvas.width(), canvas.height())?;
            let image = mask_freehand(
                canvas,
                &request.points,
                origin,
                request.toggles.cursor,
                request.cursor_pin,
            )?;
            Ok(ProducedOverlayCapture {
                image,
                attribution_regions: vec![attribution_region],
            })
        })
    }

    /// Finalize a Brush-mode capture: composite the cached snapshot
    /// through the painted alpha mask, crop to the mask's bounding box.
    /// Shares the Region finalize lifecycle (ADR 0005); like Freehand it
    /// produces a transparent-background cut-out.
    pub fn finish_brush(
        &self,
        app: &AppHandle,
        request: FinishBrushRequest,
    ) -> AppResult<OverlayResult> {
        self.finalize(app, request.toggles, None, |canvas, origin| {
            let attribution_region =
                brush_attribution_region(&request.mask, canvas.width(), canvas.height())?;
            let image = mask_brush(
                canvas,
                &request.mask,
                origin,
                request.toggles.cursor,
                request.cursor_pin,
            )?;
            Ok(ProducedOverlayCapture {
                image,
                attribution_regions: vec![attribution_region],
            })
        })
    }

    /// Finalize a Multi-Area capture: crop every rect and stitch the
    /// crops horizontally on a white background. Shares the Region
    /// finalize lifecycle (ADR 0005).
    pub fn finish_multi_area(
        &self,
        app: &AppHandle,
        request: FinishMultiAreaRequest,
    ) -> AppResult<OverlayResult> {
        self.finalize(app, request.toggles, None, |canvas, origin| {
            let attribution_regions =
                clipped_nonempty_regions(&request.rects, canvas.width(), canvas.height());
            let image = composite_multi_area(
                canvas,
                &request.rects,
                origin,
                request.toggles.cursor,
                request.cursor_pin,
                MULTI_AREA_GAP_PX,
            )?;
            Ok(ProducedOverlayCapture {
                image,
                attribution_regions,
            })
        })
    }

    /// Shared finalize lifecycle for every overlay mode that produces a
    /// saved PNG (Region / Window / Freehand / Multi-Area). Hides the
    /// overlay, takes the cached session state, runs `produce` against
    /// the cached canvas (or a live re-grab if the snapshot failed at
    /// show time), saves the PNG (honoring a preset's save-dir override),
    /// optionally copies to the clipboard, restores the previous primary
    /// window, and emits `library/updated` + `capture/finished`.
    ///
    /// `produce` returns the cropped image and its attribution regions,
    /// and owns the mode-specific crop/mask/validation against the canvas
    /// it is given. Smart-enhance and the PNG encode happen downstream in
    /// `persist_and_emit`, so no mode has to remember them.
    ///
    /// `label_override` names the capture type in the saved file name
    /// when the session's own mode isn't the right answer — Fullscreen
    /// fires from inside a Region/Window session but should not be
    /// filed as one. `None` = derive it from the session mode.
    fn finalize(
        &self,
        app: &AppHandle,
        toggles: OverlayToggles,
        label_override: Option<&'static str>,
        produce: impl FnOnce(&RgbaImage, (i32, i32)) -> AppResult<ProducedOverlayCapture>,
    ) -> AppResult<OverlayResult> {
        if let Some(overlay) = app.get_webview_window("overlay") {
            overlay.hide().map_err(AppError::from)?;
        }

        let (
            origin,
            canvas,
            previous_primary,
            output_dir,
            preset,
            source_title,
            type_label,
            windows,
            monitors,
        ) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| AppError::Overlay("state lock poisoned".into()))?;
            let canvas = guard.canvas.take();
            let prev = guard.previous_primary.take();
            let output_dir = guard.output_dir.take();
            let preset = guard.preset.take();
            let source_title = guard.source_title.take();
            let session_label = type_label_for(guard.mode.take());
            let type_label = label_override.unwrap_or(session_label);
            let windows = std::mem::take(&mut guard.windows);
            let monitors = std::mem::take(&mut guard.monitors);
            (
                guard.origin,
                canvas,
                prev,
                output_dir,
                preset,
                source_title,
                type_label,
                windows,
                monitors,
            )
        };

        // Prefer the cached canvas (overlay chrome guaranteed absent);
        // fall back to a live re-grab if the snapshot failed at show time
        // — giving the compositor a beat + a DWM swap so the re-grab
        // doesn't capture the overlay's own pixels.
        let produced = match canvas {
            Some(c) => produce(&c, origin)?,
            None => {
                window_service::sleep_compositor_unpaint(CompositorWait::Capture);
                window_service::wait_compositor_compose(2);
                let c = build_virtual_canvas()
                    .map_err(|e| AppError::Overlay(format!("live snapshot: {e}")))?;
                produce(&c, origin)?
            }
        };
        let (window_title, window_app) =
            match dominant_overlay_window(&windows, &produced.attribution_regions) {
                Some((title, app)) => (Some(title), app),
                // A window list that attributed nothing is still an
                // answer — don't fall back over it.
                None if !windows.is_empty() => (None, None),
                // No window list at all (a mode that doesn't attribute):
                // the session's remembered foreground title is the best
                // we have, and it carries no app.
                None => (source_title, None),
            };
        // Same regions, same rule: whichever display the selection mostly
        // sits on. Resolved here rather than in `persist_and_emit` because
        // the regions are the session's, not the produced image's.
        let monitor = dominant_session_monitor(&monitors, &produced.attribution_regions);

        self.persist_and_emit(
            app,
            produced,
            output_dir.as_deref(),
            CaptureSource::from_mode(type_label)
                .with_window(window_title.as_deref(), window_app.as_deref())
                .with_monitor(monitor.as_deref())
                .with_preset(preset.as_deref()),
            toggles,
            // The overlay always came from *some* primary window, so fall
            // back to "capture" when the record is missing.
            Some(previous_primary.as_deref().unwrap_or("capture")),
        )
    }

    /// Enhance → encode → save → clipboard → restore → emit: the tail
    /// every overlay capture shares once its pixels exist (ADR 0005).
    ///
    /// This is the single place Smart-enhance and the PNG encode happen,
    /// so every mode — including ones added later — gets both by
    /// construction. Enhancement runs before the encode so the saved file
    /// and the clipboard copy are the same pixels.
    ///
    /// `restore` is the primary-window label to bring back, or `None` to
    /// leave the desktop as it is. The one-shot recapture passes `None`
    /// when it was fired from the tray with no Clippity window open —
    /// popping the capture window up afterwards would be a window the
    /// user never asked for.
    ///
    /// `source` arrives fully attributed *except* for the pixel
    /// dimensions, which only exist once the image does — so this is the
    /// one field it fills in. Passing the whole [`CaptureSource`] rather
    /// than a widening list of loose provenance arguments is what keeps a
    /// new field (monitor, preset, whatever comes next) from being
    /// another parameter every caller has to thread.
    fn persist_and_emit(
        &self,
        app: &AppHandle,
        produced: ProducedOverlayCapture,
        output_dir: Option<&str>,
        source: CaptureSource<'_>,
        toggles: OverlayToggles,
        restore: Option<&str>,
    ) -> AppResult<OverlayResult> {
        let mut image = produced.image;
        if toggles.enhance {
            enhance::smart_enhance(&mut image);
        }
        let (width, height) = (image.width(), image.height());
        let png_bytes = encode_png(&image)?;

        // Persist (a preset may pin the dir via the session override) +
        // optional clipboard. `save_capture_png` also writes the
        // provenance sidecar from this same source, so every overlay
        // mode records where it came from without opting in.
        let dir = resolve_save_dir(output_dir, self.captures.captures_dir());
        let source = source.with_size(width, height);
        let path = save_capture_png(&dir, &png_bytes, &self.naming.name_template(), &source)?;
        if toggles.clipboard {
            // From the RGBA we still hold — no PNG round-trip through the
            // bytes we just encoded.
            if let Err(e) = copy_rgba_to_clipboard(&image) {
                // Clipboard failure shouldn't fail the capture itself —
                // the file is on disk; surface to logs and continue.
                tracing::warn!("overlay clipboard copy failed: {e}");
            }
        }

        let result = OverlayResult {
            id: next_id(),
            width,
            height,
            path: path.to_string_lossy().into_owned(),
            preview: toggles.preview,
        };

        // Restore whichever primary window was visible before the capture.
        // Done before emit so listeners see a painted window (matches the
        // capture-port ordering).
        if let Some(label) = restore {
            window_service::restore_window(app, label);
        }

        // Tell the library to refresh — best-effort; the capture
        // succeeded regardless of whether the event fires.
        let _ = events::emit(app, events::names::LIBRARY_UPDATED, ());
        events::emit(app, events::names::CAPTURE_FINISHED, result.clone())?;
        Ok(result)
    }

    /// One-shot repeat of the last rectangular selection — no overlay,
    /// no drag. Grabs a fresh desktop snapshot and crops the remembered
    /// rect out of it.
    ///
    /// Resolved in STRICT mode: unlike the overlay restore, nothing is
    /// shown to the user before the shutter fires, so a virtual desktop
    /// that has changed size since the region was stored is an error
    /// rather than something to clamp into range.
    pub fn recapture_last(
        &self,
        app: &AppHandle,
        toggles: OverlayToggles,
    ) -> AppResult<OverlayResult> {
        let last = self
            .last_region
            .get()
            .ok_or_else(|| AppError::Overlay("no previous region to recapture".into()))?;

        // Whatever is on screen now goes back afterwards. `None` here
        // means the flow was triggered with no Clippity window visible
        // (the tray path) — nothing to restore.
        let previous_primary = window_service::current_visible_primary(app);
        let source_title = foreground_window_title();

        // Hide our own chrome and let the compositor unpaint it before
        // grabbing, exactly as the overlay's `show` does — otherwise the
        // tray flyout ends up baked into the shot.
        if window_service::hide_primary_windows(app, "overlay") > 0 {
            window_service::sleep_compositor_unpaint(CompositorWait::Capture);
            window_service::wait_compositor_compose(2);
        }

        let (min_x, min_y, vw, vh) = virtual_bounds()?;
        let region = resolve_last_region(last, vw, vh, true).map_err(|e| {
            // Put the user's window back before surfacing the failure —
            // we already hid it.
            if let Some(label) = previous_primary {
                window_service::restore_window(app, label);
            }
            AppError::Overlay(e.into())
        })?;

        let canvas =
            build_virtual_canvas().map_err(|e| AppError::Overlay(format!("live snapshot: {e}")))?;
        let image = crop_with_optional_cursor(
            &canvas,
            region,
            (min_x, min_y),
            toggles.cursor,
            // No overlay session means no pinned cursor point — the live
            // system cursor position is the honest one here.
            None,
        )?;

        // Attribute the file name to whatever window the region lands on
        // now, falling back to whatever was focused when we started.
        let windows = gather_windows(min_x, min_y, vw, vh, OverlayMode::Region);
        let (window_title, window_app) = match dominant_overlay_window(&windows, &[region]) {
            Some((title, app)) => (Some(title), app),
            None => (source_title, None),
        };
        // No session to inherit from — this path never opened an overlay
        // — so the displays are enumerated here, against the same fresh
        // snapshot the crop came from. No preset either: a repeat is the
        // user asking for the same rect, not a preset re-running.
        let monitors = gather_monitors(min_x, min_y, vw, vh);
        let monitor = dominant_session_monitor(&monitors, &[region]);

        self.persist_and_emit(
            app,
            ProducedOverlayCapture {
                image,
                attribution_regions: vec![region],
            },
            None,
            CaptureSource::from_mode(type_label_for(Some(OverlayMode::Region)))
                .with_window(window_title.as_deref(), window_app.as_deref())
                .with_monitor(monitor.as_deref()),
            toggles,
            previous_primary,
        )
    }

    /// Sample a single pixel from the cached desktop snapshot — the
    /// Color-Picker mode. `(x, y)` are canvas-local physical pixels.
    /// Copies the `#RRGGBB` hex to the clipboard (best-effort), restores
    /// the previous primary window, and returns the sampled color. NOT a
    /// capture — produces no file and no `capture/finished` (ADR 0005).
    pub fn pick_color(&self, app: &AppHandle, x: u32, y: u32) -> AppResult<PickedColor> {
        if let Some(overlay) = app.get_webview_window("overlay") {
            overlay.hide().map_err(AppError::from)?;
        }

        let (canvas, previous_primary) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| AppError::Overlay("state lock poisoned".into()))?;
            let canvas = guard.canvas.take();
            let prev = guard.previous_primary.take();
            guard.windows.clear();
            guard.output_dir = None;
            guard.snapshot_png = None;
            guard.source_title = None;
            guard.mode = None;
            (canvas, prev)
        };
        let prev = previous_primary.as_deref().unwrap_or("capture");

        let canvas = match canvas {
            Some(c) => c,
            None => {
                window_service::restore_window(app, prev);
                return Err(AppError::Overlay("no desktop snapshot to sample".into()));
            }
        };
        if x >= canvas.width() || y >= canvas.height() {
            window_service::restore_window(app, prev);
            return Err(AppError::Overlay("pick is outside the snapshot".into()));
        }

        let px = canvas.get_pixel(x, y);
        let (r, g, b) = (px[0], px[1], px[2]);
        let hex = format!("#{r:02X}{g:02X}{b:02X}");
        if let Err(e) = copy_text_to_clipboard(&hex) {
            tracing::warn!("color-pick clipboard copy failed: {e}");
        }
        window_service::restore_window(app, prev);
        Ok(PickedColor { r, g, b, hex })
    }

    /// Palette-Capture finalize: crop the selected `rect` out of the
    /// cached snapshot and quantize it to up to `count` representative
    /// colors. Returns `(preview_data_uri, colors)` — the preview is a
    /// small PNG data URI for the toast (not persisted; the library
    /// entry is colors-only, ADR 0006). Like `pick_color`, this is NOT a
    /// file capture: the overlay closes and the previous window is
    /// restored.
    pub fn finish_palette(
        &self,
        app: &AppHandle,
        rect: Region,
        count: usize,
    ) -> AppResult<(String, Vec<AuxColor>)> {
        if let Some(overlay) = app.get_webview_window("overlay") {
            overlay.hide().map_err(AppError::from)?;
        }

        let (canvas, previous_primary) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| AppError::Overlay("state lock poisoned".into()))?;
            let canvas = guard.canvas.take();
            let prev = guard.previous_primary.take();
            guard.windows.clear();
            guard.output_dir = None;
            guard.snapshot_png = None;
            guard.source_title = None;
            guard.mode = None;
            (canvas, prev)
        };
        let prev = previous_primary.as_deref().unwrap_or("capture");

        // Cached snapshot, or a live re-grab if show-time capture failed.
        let canvas = match canvas {
            Some(c) => c,
            None => {
                window_service::sleep_compositor_unpaint(CompositorWait::Capture);
                window_service::wait_compositor_compose(2);
                match build_virtual_canvas() {
                    Ok(c) => Arc::new(c),
                    Err(e) => {
                        window_service::restore_window(app, prev);
                        return Err(AppError::Overlay(format!("live snapshot: {e}")));
                    }
                }
            }
        };

        let region = match validate_region(rect, canvas.width(), canvas.height()) {
            Ok(r) => r,
            Err(e) => {
                window_service::restore_window(app, prev);
                return Err(AppError::Overlay(e.into()));
            }
        };
        self.remember_region(region, canvas.width(), canvas.height());

        let crop =
            image::imageops::crop_imm(&*canvas, region.x, region.y, region.width, region.height)
                .to_image();
        let colors = palette::quantize(&crop, count);
        let preview = thumbnail_data_uri(&crop, PALETTE_PREVIEW_MAX_EDGE);

        window_service::restore_window(app, prev);
        Ok((preview, colors))
    }

    /// Grab-Text finalize: crop the selected `rect` out of the cached
    /// snapshot and OCR it; returns the trimmed recognized text. Like
    /// `finish_palette`, NOT a file capture — the overlay closes and the
    /// previous window is restored. The window is restored *before* the
    /// (~100-500 ms) recognize so the user isn't left on a frozen
    /// overlay. `Err(Ocr)` on an empty result so the caller surfaces "no
    /// text found" rather than persisting a blank entry.
    pub fn finish_grab_text(&self, app: &AppHandle, rect: Region) -> AppResult<String> {
        if let Some(overlay) = app.get_webview_window("overlay") {
            overlay.hide().map_err(AppError::from)?;
        }

        let (canvas, previous_primary) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| AppError::Overlay("state lock poisoned".into()))?;
            let canvas = guard.canvas.take();
            let prev = guard.previous_primary.take();
            guard.windows.clear();
            guard.output_dir = None;
            guard.snapshot_png = None;
            guard.source_title = None;
            guard.mode = None;
            (canvas, prev)
        };
        let prev = previous_primary.as_deref().unwrap_or("capture");

        let canvas = match canvas {
            Some(c) => c,
            None => {
                window_service::sleep_compositor_unpaint(CompositorWait::Capture);
                window_service::wait_compositor_compose(2);
                match build_virtual_canvas() {
                    Ok(c) => Arc::new(c),
                    Err(e) => {
                        window_service::restore_window(app, prev);
                        return Err(AppError::Overlay(format!("live snapshot: {e}")));
                    }
                }
            }
        };

        let region = match validate_region(rect, canvas.width(), canvas.height()) {
            Ok(r) => r,
            Err(e) => {
                window_service::restore_window(app, prev);
                return Err(AppError::Overlay(e.into()));
            }
        };
        self.remember_region(region, canvas.width(), canvas.height());

        let crop =
            image::imageops::crop_imm(&*canvas, region.x, region.y, region.width, region.height)
                .to_image();

        // Restore the previous window before OCR so the UI returns
        // immediately; recognition runs against the already-extracted crop.
        window_service::restore_window(app, prev);

        let text = crate::ocr_service::recognize(&crop).map_err(|e| {
            // The detailed WinRT step reason is the most useful signal for
            // triaging "Grab Text didn't work" — keep it in the backend log
            // even though the caller only surfaces a toast to the user.
            tracing::warn!(error = %e, "grab-text OCR failed");
            AppError::Ocr(e)
        })?;
        let text = text.trim().to_string();
        if text.is_empty() {
            tracing::debug!("grab-text OCR returned no readable text for the region");
            return Err(AppError::Ocr("no text found in the selected region".into()));
        }
        tracing::debug!(chars = text.len(), "grab-text OCR succeeded");
        // Auto-copy to the clipboard (best-effort) — mirrors pick_color.
        if let Err(e) = copy_text_to_clipboard(&text) {
            tracing::warn!("grab-text clipboard copy failed: {e}");
        }
        Ok(text)
    }

    /// Id of the snapshot the overlay should be showing, or `None` while
    /// the encode is still in flight (or it failed).
    ///
    /// The overlay turns this into a `clippity-snapshot` URL and lets the
    /// webview fetch the bytes, so this IPC stays a few bytes wide no
    /// matter how large the desktop is. Only `Some` once the bytes are
    /// actually servable — a URL that 404s would leave the loupe blank
    /// with nothing to retry on.
    pub fn snapshot_id(&self) -> Option<u64> {
        self.state
            .lock()
            .ok()
            .and_then(|s| s.snapshot_png.is_some().then_some(s.snapshot_id))
    }

    /// The cached snapshot's PNG bytes, for the `clippity-snapshot`
    /// protocol handler. `id` must match the current session's — a stale
    /// URL (the previous overlay's, still in the webview's cache) gets
    /// `None` rather than this session's pixels under the wrong name.
    pub fn snapshot_png(&self, id: u64) -> Option<Arc<Vec<u8>>> {
        let s = self.state.lock().ok()?;
        (s.snapshot_id == id)
            .then(|| s.snapshot_png.clone())
            .flatten()
    }

    /// The cached desktop snapshot for object detection (Object mode).
    /// `None` when no overlay session is active or its snapshot failed at
    /// show time. A handle (not a lock-held borrow) so the ~0.5–2 s
    /// inference never blocks finalize/cancel on the state lock — and,
    /// since the buffer is shared, without copying 8–33 MiB to get one.
    pub fn detection_canvas(&self) -> Option<Arc<RgbaImage>> {
        self.state.lock().ok().and_then(|s| s.canvas.clone())
    }

    /// Capturable top-level windows for the active Window-mode overlay,
    /// front-to-back. Empty when the overlay isn't open in Window mode.
    pub fn windows(&self) -> Vec<OverlayWindow> {
        self.state
            .lock()
            .ok()
            .and_then(|s| {
                // Record-Window hovers and hit-tests the same list Window
                // does — it differs only in what the click starts.
                matches!(
                    s.mode,
                    Some(OverlayMode::Window) | Some(OverlayMode::RecordWindow)
                )
                .then(|| s.windows.clone())
            })
            .unwrap_or_default()
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverlayOpeningPayload {
    mode: OverlayMode,
    cursor_position: Option<(i32, i32)>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OverlayShownPayload {
    snapshot_ok: bool,
    mode: OverlayMode,
}

/// Capture-type label for the file name, from the overlay session's
/// mode. Modes that never reach `finalize` (the color/text/palette
/// finalizers produce no file) collapse to a generic "Capture".
fn type_label_for(mode: Option<OverlayMode>) -> &'static str {
    match mode {
        Some(OverlayMode::Region) => "Region",
        Some(OverlayMode::Window) => "Window",
        Some(OverlayMode::Freehand) => "Freehand",
        Some(OverlayMode::Pen) => "Pen",
        Some(OverlayMode::MagneticLasso) => "Magnetic Lasso",
        Some(OverlayMode::Brush) => "Brush",
        Some(OverlayMode::MultiArea) => "Multi-Area",
        _ => "Capture",
    }
}

/// The focused window's title for file naming, or `None` when it can't be
/// resolved (no foreground window, blank title, or it's our own window).
/// Windows-only; other targets always get `None`.
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

// -------- Multi-monitor capture primitives (private) --------

/// Bounding box of all monitors in physical pixels: `(min_x, min_y,
/// width, height)`. This is the origin + size for the region overlay
/// window. `pub(crate)` so the panoramic worker can map a canvas-local
/// region back to virtual-screen coordinates for its scroll anchor.
pub(crate) fn virtual_bounds() -> AppResult<(i32, i32, u32, u32)> {
    let monitors = Monitor::all().map_err(|e| AppError::Overlay(e.to_string()))?;
    if monitors.is_empty() {
        return Err(AppError::Overlay("no monitors found".into()));
    }
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for m in &monitors {
        let x = m.x().map_err(|e| AppError::Overlay(e.to_string()))?;
        let y = m.y().map_err(|e| AppError::Overlay(e.to_string()))?;
        let w = m.width().map_err(|e| AppError::Overlay(e.to_string()))? as i32;
        let h = m.height().map_err(|e| AppError::Overlay(e.to_string()))? as i32;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + w);
        max_y = max_y.max(y + h);
    }
    Ok((
        min_x,
        min_y,
        (max_x - min_x).max(1) as u32,
        (max_y - min_y).max(1) as u32,
    ))
}

/// A monitor's bounds in virtual-screen physical pixels — what
/// Fullscreen-from-the-overlay crops to. Distinct from
/// [`SessionMonitor`], which is canvas-local and named, for provenance.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MonitorBounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// The monitor the cursor is currently on, in virtual-screen physical
/// pixels. Falls back to the primary monitor when the cursor position is
/// unavailable (non-Windows) or lands in a gap between mismatched
/// monitors.
///
/// "The monitor under the cursor" — not the primary — is what Fullscreen
/// means from inside the overlay: the overlay spans every display, so the
/// screen the user is pointing at is the one they mean. (The capture
/// window's own Fullscreen tile still grabs the primary monitor; it has
/// no pointer context to work from.)
fn monitor_rect_under_cursor() -> AppResult<MonitorBounds> {
    let monitors = Monitor::all().map_err(|e| AppError::Overlay(e.to_string()))?;
    let mut rects: Vec<(MonitorBounds, bool)> = Vec::with_capacity(monitors.len());
    for m in &monitors {
        rects.push((
            MonitorBounds {
                x: m.x().map_err(|e| AppError::Overlay(e.to_string()))?,
                y: m.y().map_err(|e| AppError::Overlay(e.to_string()))?,
                width: m.width().map_err(|e| AppError::Overlay(e.to_string()))?,
                height: m.height().map_err(|e| AppError::Overlay(e.to_string()))?,
            },
            m.is_primary().unwrap_or(false),
        ));
    }
    if rects.is_empty() {
        return Err(AppError::Overlay("no monitors found".into()));
    }

    #[cfg(target_os = "windows")]
    if let Some((cx, cy)) = clippity_platform::windows::cursor::screen_position() {
        if let Some((hit, _)) = rects.iter().find(|(r, _)| contains_point(*r, cx, cy)) {
            return Ok(*hit);
        }
    }

    Ok(rects
        .iter()
        .find(|(_, primary)| *primary)
        .unwrap_or(&rects[0])
        .0)
}

/// Pure: does `rect` contain the virtual-screen point `(x, y)`?
/// Half-open on the far edges so two abutting monitors never both claim
/// the same pixel column/row.
fn contains_point(rect: MonitorBounds, x: i32, y: i32) -> bool {
    x >= rect.x
        && y >= rect.y
        && x < rect.x.saturating_add(rect.width as i32)
        && y < rect.y.saturating_add(rect.height as i32)
}

/// Pure: rebase a virtual-screen monitor rect onto the snapshot canvas
/// (whose `(0, 0)` is `origin`) and clip it to the canvas. Errors when
/// the monitor doesn't overlap the canvas at all — a display that
/// appeared after the snapshot was taken.
fn rect_on_canvas(
    rect: MonitorBounds,
    origin: (i32, i32),
    canvas_w: u32,
    canvas_h: u32,
) -> AppResult<Region> {
    let (ox, oy) = origin;
    let left = rect.x - ox;
    let top = rect.y - oy;
    let right = left.saturating_add(rect.width as i32).min(canvas_w as i32);
    let bottom = top.saturating_add(rect.height as i32).min(canvas_h as i32);
    let left = left.max(0);
    let top = top.max(0);
    if right <= left || bottom <= top {
        return Err(AppError::Overlay(
            "that monitor is outside the captured desktop".into(),
        ));
    }
    Ok(Region {
        x: left as u32,
        y: top as u32,
        width: (right - left) as u32,
        height: (bottom - top) as u32,
    })
}

fn cursor_canvas_position(
    origin_x: i32,
    origin_y: i32,
    width: u32,
    height: u32,
) -> Option<(i32, i32)> {
    #[cfg(target_os = "windows")]
    {
        let (screen_x, screen_y) = clippity_platform::windows::cursor::screen_position()?;
        let max_x = width.saturating_sub(1) as i32;
        let max_y = height.saturating_sub(1) as i32;
        Some((
            (screen_x - origin_x).clamp(0, max_x),
            (screen_y - origin_y).clamp(0, max_y),
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (origin_x, origin_y, width, height);
        None
    }
}

/// How faithfully a canvas grab should reproduce an HDR display.
///
/// The distinction exists because this function is called from two
/// places with very different budgets: once per *capture* (where a
/// millisecond is free and correctness is everything) and once per
/// *frame* of a straddling recording (where 60 of them happen a second).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CanvasColor {
    /// Grab each monitor the way it is actually composed — the scRGB
    /// float path on a display running in HDR, tone-mapped down. Costs
    /// a display-config query per monitor, plus a D3D device and a
    /// staging read-back for each HDR one.
    Accurate,
    /// Ordinary 8-bit grab from every monitor, HDR or not.
    Sdr,
}

/// Build the stitched virtual-desktop image (all monitors composited
/// into one `RgbaImage` whose `(0, 0)` is the virtual-desktop top-left).
///
/// HDR-accurate. Use [`build_virtual_canvas_sdr`] on a per-frame path.
pub(crate) fn build_virtual_canvas() -> AppResult<RgbaImage> {
    build_virtual_canvas_with(CanvasColor::Accurate)
}

/// [`build_virtual_canvas`] without the HDR path.
///
/// For callers that run this per frame rather than per capture. The
/// recorder is the one that matters: its straddling-region path rebuilds
/// the whole canvas for every frame, and setting up a Direct3D device
/// and a staging read-back 60 times a second — per HDR monitor — would
/// cost far more than the recording is worth. A recording off an HDR
/// display therefore has the same washed-out look a screenshot used to;
/// fixing that properly means holding one duplication open across the
/// session rather than making this call slower.
pub(crate) fn build_virtual_canvas_sdr() -> AppResult<RgbaImage> {
    build_virtual_canvas_with(CanvasColor::Sdr)
}

fn build_virtual_canvas_with(color: CanvasColor) -> AppResult<RgbaImage> {
    let (min_x, min_y, vw, vh) = virtual_bounds()?;
    let monitors = Monitor::all().map_err(|e| AppError::Overlay(e.to_string()))?;

    let mut canvas: RgbaImage = RgbaImage::new(vw, vh);
    for m in &monitors {
        let mx = m.x().map_err(|e| AppError::Overlay(e.to_string()))?;
        let my = m.y().map_err(|e| AppError::Overlay(e.to_string()))?;
        // Per monitor, not per canvas: HDR is a per-display mode, so a
        // desk with one HDR panel and one SDR panel has to grab each
        // one the way that display is actually composed. `None` is the
        // ordinary path — see `platform::windows::hdr_capture`.
        let hdr = match color {
            CanvasColor::Accurate => hdr_grab_at(mx, my),
            CanvasColor::Sdr => None,
        };
        let img = match hdr {
            Some(img) => img,
            None => m
                .capture_image()
                .map_err(|e| AppError::Overlay(e.to_string()))?,
        };
        image::imageops::replace(&mut canvas, &img, (mx - min_x) as i64, (my - min_y) as i64);
    }
    Ok(canvas)
}

/// Tone-mapped RGBA for the monitor at a screen point, when that
/// monitor is running in HDR. `None` means "use the ordinary grab".
///
/// Mirrors `capture_service::hdr_grab_at`, including the one-pixel
/// nudge inside the origin — a monitor's top-left corner is shared with
/// its neighbour, and `MonitorFromPoint` may resolve it either way.
/// Duplicated rather than promoted: each is a three-line `cfg` shim over
/// the same platform call, and the shared thing they would be promoted
/// *to* is the platform function they both already call.
#[cfg(target_os = "windows")]
fn hdr_grab_at(x: i32, y: i32) -> Option<RgbaImage> {
    clippity_platform::windows::hdr_capture::rgba_monitor_at(x + 1, y + 1)
}

#[cfg(not(target_os = "windows"))]
fn hdr_grab_at(_x: i32, _y: i32) -> Option<RgbaImage> {
    None
}

/// Enumerate capturable windows for file-producing overlay modes and
/// rebase each onto the snapshot canvas. Empty for non-file modes and
/// on non-Windows.
#[cfg(target_os = "windows")]
fn gather_windows(
    min_x: i32,
    min_y: i32,
    vw: u32,
    vh: u32,
    mode: OverlayMode,
) -> Vec<OverlayWindow> {
    if !mode_uses_window_attribution(mode) {
        return Vec::new();
    }
    clippity_platform::windows::enumeration::list_capturable_windows()
        .into_iter()
        .filter_map(|f| {
            frame_to_region((f.x, f.y, f.width, f.height), (min_x, min_y, vw, vh)).map(|rect| {
                OverlayWindow {
                    id: f.id,
                    title: f.title,
                    app: f.app,
                    rect,
                }
            })
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn gather_windows(_: i32, _: i32, _: u32, _: u32, _: OverlayMode) -> Vec<OverlayWindow> {
    Vec::new()
}

/// Enumerate the displays behind the snapshot and rebase each onto the
/// canvas, sharing `frame_to_region` with the window list so a monitor
/// and a window on it land in the same coordinate space.
///
/// Unlike `gather_windows` this runs for **every** mode: a Color-Pick or
/// Palette session produces no file today, but the cost is one
/// already-cached display enumeration (`virtual_bounds` and
/// `build_virtual_canvas` each just made the same call), and gating it
/// per-mode is how a future file-producing mode ships without a display.
///
/// A monitor whose device name can't be read is skipped rather than
/// listed nameless — an entry that can win attribution and then record
/// nothing is worse than not competing.
fn gather_monitors(min_x: i32, min_y: i32, vw: u32, vh: u32) -> Vec<SessionMonitor> {
    let Ok(monitors) = Monitor::all() else {
        return Vec::new();
    };
    monitors
        .iter()
        .filter_map(|m| {
            let name = m.name().ok().and_then(|n| metadata::monitor_label(&n))?;
            let frame = (m.x().ok()?, m.y().ok()?, m.width().ok()?, m.height().ok()?);
            frame_to_region(frame, (min_x, min_y, vw, vh)).map(|rect| SessionMonitor { name, rect })
        })
        .collect()
}

/// The display `regions` (canvas-local) sit on, resolved against the
/// CURRENT display layout.
///
/// For producers with no overlay session to inherit a frozen monitor
/// list from — the scroll/panoramic recorder, which resolves this once at
/// `start` because a stitch has no single instant to resolve it at.
pub(crate) fn monitor_for_regions(regions: &[Region]) -> Option<String> {
    let (min_x, min_y, vw, vh) = virtual_bounds().ok()?;
    let monitors = gather_monitors(min_x, min_y, vw, vh);
    dominant_session_monitor(&monitors, regions)
}

/// The display contributing the most pixels to `capture_regions`, as the
/// label the record stores. `None` when the session listed no displays
/// (enumeration failed) or the regions land on none of them.
fn dominant_session_monitor(
    monitors: &[SessionMonitor],
    capture_regions: &[Region],
) -> Option<String> {
    let monitor_rects: Vec<_> = monitors
        .iter()
        .map(|m| MonitorRect {
            name: m.name.as_str(),
            rect: attribution_rect(m.rect),
        })
        .collect();
    let regions: Vec<_> = capture_regions
        .iter()
        .copied()
        .map(attribution_rect)
        .collect();
    window_attribution::dominant_monitor(&monitor_rects, &regions).map(|m| m.name.to_owned())
}

fn mode_uses_window_attribution(mode: OverlayMode) -> bool {
    matches!(
        mode,
        OverlayMode::Region
            | OverlayMode::Window
            | OverlayMode::Freehand
            | OverlayMode::Pen
            | OverlayMode::MagneticLasso
            | OverlayMode::Brush
            | OverlayMode::MultiArea
            // Record-Window needs the list to hover and hit-test against,
            // not to name a capture after. Record-Region is deliberately
            // absent: a recording is named from its target and monitor,
            // so enumerating windows on its overlay-open path would be
            // work nothing reads.
            | OverlayMode::RecordWindow
    )
}

/// Rebase an absolute virtual-screen window frame `(fx, fy, fw, fh)`
/// onto the snapshot canvas described by `(min_x, min_y, vw, vh)` (the
/// `virtual_bounds()` tuple) and clip to it, returning the on-canvas
/// portion as a `Region` — or `None` if the window lies entirely off
/// the captured desktop. Pure; unit-tested below.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn frame_to_region(frame: (i32, i32, u32, u32), canvas: (i32, i32, u32, u32)) -> Option<Region> {
    let (fx, fy, fw, fh) = frame;
    let (min_x, min_y, vw, vh) = canvas;
    let left = (fx - min_x).max(0);
    let top = (fy - min_y).max(0);
    let right = (fx - min_x + fw as i32).min(vw as i32);
    let bottom = (fy - min_y + fh as i32).min(vh as i32);
    let width = right - left;
    let height = bottom - top;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(Region {
        x: left as u32,
        y: top as u32,
        width: width as u32,
        height: height as u32,
    })
}

/// The window contributing the most visible pixels to `capture_regions`
/// as `(title, app)`. The app is `None` when the process couldn't be
/// resolved — `domain::metadata` and the `{app}` naming token both read
/// a blank as absent, so it is normalised once, here.
///
/// Returns both together (rather than a title now and an app later) so
/// a capture's name and its provenance record can't end up describing
/// two different windows.
fn dominant_overlay_window(
    windows: &[OverlayWindow],
    capture_regions: &[Region],
) -> Option<(String, Option<String>)> {
    let window_rects: Vec<_> = windows
        .iter()
        .map(|w| WindowRect {
            title: w.title.as_str(),
            app: w.app.as_str(),
            rect: attribution_rect(w.rect),
        })
        .collect();
    let regions: Vec<_> = capture_regions
        .iter()
        .copied()
        .map(attribution_rect)
        .collect();
    window_attribution::dominant_window(&window_rects, &regions).map(|w| {
        let app = (!w.app.trim().is_empty()).then(|| w.app.to_owned());
        (w.title.to_owned(), app)
    })
}

fn attribution_rect(r: Region) -> AttributionRect {
    AttributionRect {
        x: r.x as i32,
        y: r.y as i32,
        width: r.width,
        height: r.height,
    }
}

fn freehand_attribution_region(
    points: &[(i32, i32)],
    canvas_width: u32,
    canvas_height: u32,
) -> AppResult<Region> {
    if points.len() < clippity_domain::overlay::MIN_FREEHAND_POINTS {
        return Err(AppError::Overlay(
            "freehand path needs at least 3 points".into(),
        ));
    }
    if canvas_width == 0 || canvas_height == 0 {
        return Err(AppError::Overlay(
            "freehand path outside the desktop bounds".into(),
        ));
    }
    let (min_x, min_y, max_x, max_y) =
        polygon_bounds(points).ok_or_else(|| AppError::Overlay("freehand path is empty".into()))?;
    let x0 = min_x.max(0);
    let y0 = min_y.max(0);
    let x1 = max_x.min(canvas_width as i32 - 1);
    let y1 = max_y.min(canvas_height as i32 - 1);
    if x1 < x0 || y1 < y0 {
        return Err(AppError::Overlay(
            "freehand path outside the desktop bounds".into(),
        ));
    }
    Ok(Region {
        x: x0 as u32,
        y: y0 as u32,
        width: (x1 - x0 + 1) as u32,
        height: (y1 - y0 + 1) as u32,
    })
}

/// Clip a brush mask's bounding box to the canvas, returning the on-canvas
/// portion as a `Region` for filename attribution. Also validates the RLE
/// decodes to its declared area (the backend never trusts client coords).
fn brush_attribution_region(
    mask: &BrushMask,
    canvas_width: u32,
    canvas_height: u32,
) -> AppResult<Region> {
    if canvas_width == 0 || canvas_height == 0 {
        return Err(AppError::Overlay(
            "brush mask outside the desktop bounds".into(),
        ));
    }
    mask.decode().map_err(|e| AppError::Overlay(e.into()))?;
    let x0 = mask.x.max(0);
    let y0 = mask.y.max(0);
    let x1 = (mask.x + mask.width as i32 - 1).min(canvas_width as i32 - 1);
    let y1 = (mask.y + mask.height as i32 - 1).min(canvas_height as i32 - 1);
    if x1 < x0 || y1 < y0 {
        return Err(AppError::Overlay(
            "brush mask outside the desktop bounds".into(),
        ));
    }
    Ok(Region {
        x: x0 as u32,
        y: y0 as u32,
        width: (x1 - x0 + 1) as u32,
        height: (y1 - y0 + 1) as u32,
    })
}

fn clipped_nonempty_regions(
    rects: &[Region],
    canvas_width: u32,
    canvas_height: u32,
) -> Vec<Region> {
    rects
        .iter()
        .copied()
        .filter_map(|r| {
            if r.width == 0 || r.height == 0 || r.x >= canvas_width || r.y >= canvas_height {
                return None;
            }
            let width = r.width.min(canvas_width - r.x);
            let height = r.height.min(canvas_height - r.y);
            (width > 0 && height > 0).then_some(Region {
                x: r.x,
                y: r.y,
                width,
                height,
            })
        })
        .collect()
}

/// Crop `region` out of `canvas`, optionally compositing the cursor
/// (clipped to the crop). Encoding happens downstream in
/// `persist_and_emit`.
fn crop_with_optional_cursor(
    canvas: &RgbaImage,
    region: Region,
    origin: (i32, i32),
    include_cursor: bool,
    cursor_pin: Option<(i32, i32)>,
) -> AppResult<RgbaImage> {
    let (ox, oy) = origin;

    // Compositing requires mutation; clone only if needed.
    let canvas_owned;
    let canvas_ref: &RgbaImage = if include_cursor {
        canvas_owned = {
            let mut c = canvas.clone();
            // Pass the crop rect as the cursor clip so a pinned
            // cursor can't have its body chopped off by the crop.
            let clip = Some((
                region.x as i32,
                region.y as i32,
                region.width as i32,
                region.height as i32,
            ));
            #[cfg(target_os = "windows")]
            clippity_platform::windows::cursor::composite_cursor(&mut c, ox, oy, cursor_pin, clip);
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (cursor_pin, clip, ox, oy);
            }
            c
        };
        &canvas_owned
    } else {
        let _ = (ox, oy);
        canvas
    };

    let (vw, vh) = (canvas_ref.width(), canvas_ref.height());
    let max_w = vw.saturating_sub(region.x);
    let max_h = vh.saturating_sub(region.y);
    let cropped = image::imageops::crop_imm(
        canvas_ref,
        region.x.min(vw),
        region.y.min(vh),
        region.width.min(max_w),
        region.height.min(max_h),
    )
    .to_image();

    if cropped.width() == 0 || cropped.height() == 0 {
        return Err(AppError::Overlay(
            "selection outside the desktop bounds".into(),
        ));
    }
    Ok(cropped)
}

/// PNG-encode a finished capture. Matches `DynamicImage::write_to(Png)`'s
/// defaults (deflate `Default` + adaptive filtering), which is what every
/// overlay mode encoded with before the encode was hoisted here.
fn encode_png(image: &RgbaImage) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(
        Cursor::new(&mut bytes),
        CompressionType::Default,
        FilterType::Adaptive,
    )
    .write_image(
        image.as_raw(),
        image.width(),
        image.height(),
        ExtendedColorType::Rgba8,
    )
    .map_err(|e| AppError::Overlay(format!("png encode: {e}")))?;
    Ok(bytes)
}

/// Mask everything outside the freehand `points` polygon to transparent
/// and crop to the path's bounding box. Optionally composites the cursor
/// (clipped to the bbox, like `crop_with_optional_cursor`) at
/// `cursor_pin`. `points` are canvas-local physical pixels; `origin` is
/// the canvas's virtual-screen top-left for cursor placement.
fn mask_freehand(
    canvas: &RgbaImage,
    points: &[(i32, i32)],
    origin: (i32, i32),
    include_cursor: bool,
    cursor_pin: Option<(i32, i32)>,
) -> AppResult<RgbaImage> {
    if points.len() < clippity_domain::overlay::MIN_FREEHAND_POINTS {
        return Err(AppError::Overlay(
            "freehand path needs at least 3 points".into(),
        ));
    }
    let (cw, ch) = (canvas.width() as i32, canvas.height() as i32);
    let (min_x, min_y, max_x, max_y) =
        polygon_bounds(points).ok_or_else(|| AppError::Overlay("freehand path is empty".into()))?;
    let x0 = min_x.max(0);
    let y0 = min_y.max(0);
    let x1 = max_x.min(cw - 1);
    let y1 = max_y.min(ch - 1);
    if x1 < x0 || y1 < y0 {
        return Err(AppError::Overlay(
            "freehand path outside the desktop bounds".into(),
        ));
    }
    let w = (x1 - x0 + 1) as u32;
    let h = (y1 - y0 + 1) as u32;

    // Optional cursor compositing — clip to the bbox so a pinned cursor's
    // body can't fall outside the crop (mirrors crop_with_optional_cursor).
    let canvas_owned;
    let canvas_ref: &RgbaImage = if include_cursor {
        let (ox, oy) = origin;
        canvas_owned = {
            let mut c = canvas.clone();
            #[cfg(target_os = "windows")]
            clippity_platform::windows::cursor::composite_cursor(
                &mut c,
                ox,
                oy,
                cursor_pin,
                Some((x0, y0, w as i32, h as i32)),
            );
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (ox, oy, cursor_pin);
            }
            c
        };
        &canvas_owned
    } else {
        let _ = (origin, cursor_pin);
        canvas
    };

    // Translate the path into bbox-local coordinates so the point-in-
    // polygon test is cheap. Pixels outside the polygon stay at the
    // zeroed (fully transparent) default of a fresh RgbaImage.
    let local: Vec<(i32, i32)> = points.iter().map(|&(x, y)| (x - x0, y - y0)).collect();
    let mut out = RgbaImage::new(w, h);
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            if point_in_polygon(x, y, &local) {
                out.put_pixel(
                    x as u32,
                    y as u32,
                    *canvas_ref.get_pixel((x + x0) as u32, (y + y0) as u32),
                );
            }
        }
    }

    Ok(out)
}

/// Composite `canvas` through a painted brush `mask` (canvas-local
/// physical pixels) and crop to the mask's bounding box. The source
/// pixel's alpha is scaled by the mask's coverage so soft-edged strokes
/// feather into transparency; zero-coverage pixels stay fully
/// transparent. Optionally composites the cursor (clipped to the bbox,
/// like `mask_freehand`).
fn mask_brush(
    canvas: &RgbaImage,
    mask: &BrushMask,
    origin: (i32, i32),
    include_cursor: bool,
    cursor_pin: Option<(i32, i32)>,
) -> AppResult<RgbaImage> {
    let alpha = mask.decode().map_err(|e| AppError::Overlay(e.into()))?;
    let (cw, ch) = (canvas.width() as i32, canvas.height() as i32);
    let (w, h) = (mask.width, mask.height);

    // Optional cursor compositing — clip to the mask bbox so a pinned
    // cursor's body can't fall outside the crop (mirrors mask_freehand).
    let canvas_owned;
    let canvas_ref: &RgbaImage = if include_cursor {
        let (ox, oy) = origin;
        canvas_owned = {
            let mut c = canvas.clone();
            #[cfg(target_os = "windows")]
            clippity_platform::windows::cursor::composite_cursor(
                &mut c,
                ox,
                oy,
                cursor_pin,
                Some((mask.x, mask.y, w as i32, h as i32)),
            );
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (ox, oy, cursor_pin);
            }
            c
        };
        &canvas_owned
    } else {
        let _ = (origin, cursor_pin);
        canvas
    };

    let mut out = RgbaImage::new(w, h);
    let mut has_ink = false;
    for my in 0..h as i32 {
        for mx in 0..w as i32 {
            let a = alpha[(my as u32 * w + mx as u32) as usize];
            if a == 0 {
                continue;
            }
            let (sx, sy) = (mask.x + mx, mask.y + my);
            if sx < 0 || sy < 0 || sx >= cw || sy >= ch {
                continue; // off-canvas → leave transparent
            }
            has_ink = true;
            let mut px = *canvas_ref.get_pixel(sx as u32, sy as u32);
            // Feather: scale the source alpha by the mask coverage.
            px.0[3] = ((px.0[3] as u16 * a as u16) / 255) as u8;
            out.put_pixel(mx as u32, my as u32, px);
        }
    }
    if !has_ink {
        return Err(AppError::Overlay("brush mask is empty".into()));
    }
    Ok(out)
}

/// Crop each `rect` out of `canvas` and stitch the crops left-to-right on
/// a white background with `gap` px between them. Optionally composites
/// the cursor (live position, unclipped) onto a single shared canvas
/// before cropping so it appears at most once. Rects that resolve to an
/// empty crop (off-canvas / zero-area) are skipped.
fn composite_multi_area(
    canvas: &RgbaImage,
    rects: &[Region],
    origin: (i32, i32),
    include_cursor: bool,
    cursor_pin: Option<(i32, i32)>,
    gap: u32,
) -> AppResult<RgbaImage> {
    if rects.is_empty() {
        return Err(AppError::Overlay("no regions to composite".into()));
    }

    let canvas_owned;
    let canvas_ref: &RgbaImage = if include_cursor {
        let (ox, oy) = origin;
        canvas_owned = {
            let mut c = canvas.clone();
            #[cfg(target_os = "windows")]
            clippity_platform::windows::cursor::composite_cursor(&mut c, ox, oy, cursor_pin, None);
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (ox, oy, cursor_pin);
            }
            c
        };
        &canvas_owned
    } else {
        let _ = (origin, cursor_pin);
        canvas
    };

    let mut crops: Vec<RgbaImage> = Vec::with_capacity(rects.len());
    for r in rects {
        if r.width == 0 || r.height == 0 || r.x >= canvas_ref.width() || r.y >= canvas_ref.height()
        {
            continue;
        }
        let w = r.width.min(canvas_ref.width() - r.x);
        let h = r.height.min(canvas_ref.height() - r.y);
        if w == 0 || h == 0 {
            continue;
        }
        crops.push(image::imageops::crop_imm(canvas_ref, r.x, r.y, w, h).to_image());
    }
    if crops.is_empty() {
        return Err(AppError::Overlay(
            "all regions resolved to empty crops".into(),
        ));
    }

    let total_w: u32 =
        crops.iter().map(|c| c.width()).sum::<u32>() + gap * (crops.len() as u32 - 1);
    let total_h: u32 = crops.iter().map(|c| c.height()).max().unwrap_or(0);

    let mut out = RgbaImage::from_pixel(total_w, total_h, image::Rgba([255, 255, 255, 255]));
    let mut x: u32 = 0;
    for crop in &crops {
        image::imageops::replace(&mut out, crop, x as i64, 0);
        x += crop.width() + gap;
    }

    Ok(out)
}

/// Encode the cached desktop canvas as PNG bytes for the overlay to
/// fetch over the `clippity-snapshot` scheme. Best-effort: returns `None`
/// if PNG encoding fails (the loupe just won't sample pixels until the
/// next session).
///
/// The cursor is deliberately NOT composited in. This image is the
/// overlay's frozen-desktop backdrop, the magnifier's magnified view,
/// AND the source of its RGB readout, so it has to be the same pixels
/// `finalize` will crop — anything extra is a lie in all three places:
///
///   - The backdrop would show a cursor that isn't in the capture
///     whenever the Capture-cursor toggle is off.
///   - The loupe's sampled colour would disagree with `pick_color`,
///     which samples the cursor-free canvas.
///   - Even with the toggle ON it was wrong: this is baked at `show`
///     time, but the capture composites the cursor at `cursor_pin` —
///     wherever the pointer ended up inside the selection — so the
///     preview drew it in a stale position.
///
/// With the toggle on, the cursor therefore isn't previewed at all. The
/// crosshair already marks the pointer, which is the honest cue.
///
/// Uses `CompressionType::Fast` (zlib level 1) + `FilterType::NoFilter`
/// rather than the default zlib level 6. These bytes live for one overlay
/// session and travel over a local socket, so encode time matters and
/// size barely does — measured on a real desktop, this level compresses a
/// 1920×1200 canvas from 8.79 MiB to ~8.25 MiB, so the higher levels
/// would be paying tens of milliseconds for a rounding error.
///
/// Lossless is not negotiable, though: the loupe reads its RGB readout
/// out of these pixels, and `pick_color` samples the canvas they came
/// from. A lossy codec would make the two disagree on the hex the user is
/// about to copy.
fn render_loupe_png(canvas: &RgbaImage) -> Option<Vec<u8>> {
    let (width, height) = (canvas.width(), canvas.height());
    let mut bytes = Vec::new();
    let encoder = PngEncoder::new_with_quality(
        Cursor::new(&mut bytes),
        CompressionType::Fast,
        FilterType::NoFilter,
    );
    encoder
        .write_image(canvas.as_raw(), width, height, ExtendedColorType::Rgba8)
        .ok()?;
    Some(bytes)
}

// Post-capture PNG / clipboard / id helpers live in
// `services::capture_io` — single source of truth once the overlay
// port made them dual-consumer with capture_service.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings_service::{StaticCapturesDir, StaticNameTemplate};
    use std::path::PathBuf;

    // Sanity: the OverlayService's pure-helper boundary — anything that
    // crosses into xcap or the AppHandle stays uncovered here (covered
    // by Step 4 manual validation). What we CAN unit-test is that the
    // service constructs without panicking and that mode dispatch
    // routes Region through finish_region (vs Unsupported for other
    // variants). The latter is a future-proofing check; today every
    // non-Region variant lands at the same `validate_mode` gate.

    /// Regression: the loupe data URI used to have the system cursor
    /// composited into it. That image is the overlay's frozen backdrop
    /// AND the loupe's colour-sample source, so the extra pixels showed
    /// a cursor on the overlay even with Capture-cursor off, and made
    /// the loupe's readout disagree with `pick_color` (which samples the
    /// cursor-free canvas).
    ///
    /// The invariant that forbids it: what the overlay is shown must be
    /// pixel-identical to the canvas `finalize` crops.
    ///
    /// Caveat on how much this catches — `composite_cursor` draws at the
    /// LIVE cursor position, so against this small canvas it would only
    /// perturb the pixels when the pointer happens to sit in the
    /// top-left 8×4 of the screen (and not at all on a headless runner).
    /// This reliably catches any unconditional transform and documents
    /// the requirement; catching the cursor case specifically would need
    /// the platform cursor behind an injectable seam, which it isn't.
    #[test]
    fn loupe_png_is_pixel_identical_to_the_canvas() {
        let mut canvas = RgbaImage::new(8, 4);
        for (i, px) in canvas.pixels_mut().enumerate() {
            let v = (i * 7) as u8;
            *px = image::Rgba([v, 255 - v, v / 2, 255]);
        }

        let bytes = render_loupe_png(&canvas).expect("encodes");
        let decoded = image::load_from_memory(&bytes)
            .expect("valid png")
            .to_rgba8();

        // Lossless, byte for byte: the loupe reads its RGB readout out of
        // these pixels and `pick_color` samples the canvas they came
        // from, so any codec that rounded would make the two disagree
        // about the hex the user is copying.
        assert_eq!(decoded.dimensions(), canvas.dimensions());
        assert_eq!(decoded.as_raw(), canvas.as_raw());
    }

    #[test]
    fn service_constructs() {
        let captures: Arc<dyn CapturesDirSource> =
            Arc::new(StaticCapturesDir(PathBuf::from("/tmp")));
        let naming: Arc<dyn NameTemplateSource> = Arc::new(StaticNameTemplate(String::new()));
        let last_region = Arc::new(LastRegionStore::at(
            std::env::temp_dir().join("clippity-overlay-service-test-last-region.json"),
        ));
        let svc = OverlayService::new(captures, naming, last_region);
        assert!(svc.snapshot_id().is_none());
        assert!(svc.snapshot_png(0).is_none());
        assert!(svc.windows().is_empty());
    }

    #[test]
    fn frame_to_region_window_fully_inside() {
        let r = frame_to_region((100, 50, 800, 600), (0, 0, 1920, 1080)).unwrap();
        assert_eq!(
            r,
            Region {
                x: 100,
                y: 50,
                width: 800,
                height: 600
            }
        );
    }

    #[test]
    fn frame_to_region_secondary_monitor_negative_origin() {
        // Virtual desktop starts at x=-1920 (a monitor to the left of
        // primary). A window filling that monitor rebases to x=0.
        let r = frame_to_region((-1920, 0, 800, 600), (-1920, 0, 3840, 1080)).unwrap();
        assert_eq!(
            r,
            Region {
                x: 0,
                y: 0,
                width: 800,
                height: 600
            }
        );
    }

    #[test]
    fn frame_to_region_clips_overhang_at_canvas_edge() {
        // Window starts inside but runs past the right edge — width is
        // clipped to the visible portion.
        let r = frame_to_region((1800, 0, 800, 600), (0, 0, 1920, 1080)).unwrap();
        assert_eq!(
            r,
            Region {
                x: 1800,
                y: 0,
                width: 120,
                height: 600
            }
        );
    }

    #[test]
    fn frame_to_region_rejects_fully_offscreen() {
        assert!(frame_to_region((5000, 0, 800, 600), (0, 0, 1920, 1080)).is_none());
    }

    fn mon(x: i32, y: i32, width: u32, height: u32) -> MonitorBounds {
        MonitorBounds {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn contains_point_is_half_open_so_abutting_monitors_dont_overlap() {
        let left = mon(0, 0, 1920, 1080);
        let right = mon(1920, 0, 1920, 1080);
        // The shared seam belongs to exactly one of them.
        assert!(contains_point(left, 1919, 0));
        assert!(!contains_point(left, 1920, 0));
        assert!(contains_point(right, 1920, 0));
        // Bottom edge behaves the same way.
        assert!(contains_point(left, 0, 1079));
        assert!(!contains_point(left, 0, 1080));
        // Negative-origin monitors (a display left of the primary).
        let secondary = mon(-1600, -200, 1600, 900);
        assert!(contains_point(secondary, -1600, -200));
        assert!(!contains_point(secondary, 0, 0));
    }

    #[test]
    fn rect_on_canvas_rebases_against_the_snapshot_origin() {
        // Virtual desktop spans (-1920, 0)..(1920, 1080); the canvas's
        // (0, 0) is the leftmost monitor's top-left.
        let origin = (-1920, 0);
        let primary = mon(0, 0, 1920, 1080);
        assert_eq!(
            rect_on_canvas(primary, origin, 3840, 1080).unwrap(),
            Region {
                x: 1920,
                y: 0,
                width: 1920,
                height: 1080,
            }
        );
        let secondary = mon(-1920, 0, 1920, 1080);
        assert_eq!(
            rect_on_canvas(secondary, origin, 3840, 1080).unwrap(),
            Region {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            }
        );
    }

    #[test]
    fn rect_on_canvas_clips_a_monitor_that_overhangs_the_canvas() {
        // A monitor taller than the snapshot (canvas built before a
        // resolution change) clips rather than producing an out-of-bounds
        // crop.
        let got = rect_on_canvas(mon(0, 0, 1920, 1440), (0, 0), 1920, 1080).unwrap();
        assert_eq!(got.height, 1080);
        assert_eq!(got.width, 1920);
    }

    #[test]
    fn rect_on_canvas_rejects_a_monitor_outside_the_canvas() {
        // A display hot-plugged after the snapshot was taken has no
        // pixels to crop.
        assert!(rect_on_canvas(mon(4000, 0, 1920, 1080), (0, 0), 1920, 1080).is_err());
    }

    fn win(id: u64, title: &str, rect: Region) -> OverlayWindow {
        OverlayWindow {
            id,
            title: title.to_string(),
            app: String::new(),
            rect,
        }
    }

    #[test]
    fn dominant_overlay_window_picks_largest_visible_overlap() {
        let windows = [
            win(
                1,
                "Foreground",
                Region {
                    x: 0,
                    y: 0,
                    width: 80,
                    height: 100,
                },
            ),
            win(
                2,
                "Background",
                Region {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                },
            ),
        ];
        let capture = [Region {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        }];
        assert_eq!(
            dominant_overlay_window(&windows, &capture),
            Some(("Foreground".to_string(), None))
        );
    }

    #[test]
    fn dominant_overlay_window_sums_multi_area_regions() {
        let windows = [
            win(
                1,
                "Left",
                Region {
                    x: 0,
                    y: 0,
                    width: 50,
                    height: 50,
                },
            ),
            win(
                2,
                "Right",
                Region {
                    x: 100,
                    y: 0,
                    width: 100,
                    height: 50,
                },
            ),
        ];
        let capture = [
            Region {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            },
            Region {
                x: 100,
                y: 0,
                width: 100,
                height: 50,
            },
        ];
        assert_eq!(
            dominant_overlay_window(&windows, &capture),
            Some(("Right".to_string(), None))
        );
    }

    #[test]
    fn dominant_overlay_window_reports_the_owning_app() {
        let windows = [OverlayWindow {
            id: 1,
            title: "GitHub - Chrome".into(),
            app: "Chrome".into(),
            rect: Region {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
            },
        }];
        let capture = [Region {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        }];
        assert_eq!(
            dominant_overlay_window(&windows, &capture),
            Some(("GitHub - Chrome".to_string(), Some("Chrome".to_string())))
        );
    }

    #[test]
    fn dominant_overlay_window_treats_an_unresolved_app_as_absent() {
        // A protected process yields "" from the enumerator; the
        // metadata record and the {app} token both mean "absent" by
        // that, so it must not reach either as an empty string.
        let windows = [win(
            1,
            "Secure",
            Region {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
        )];
        let capture = [Region {
            x: 0,
            y: 0,
            width: 10,
            height: 10,
        }];
        let (title, app) = dominant_overlay_window(&windows, &capture).unwrap();
        assert_eq!(title, "Secure");
        assert_eq!(app, None);
    }

    #[test]
    fn dominant_overlay_window_returns_none_without_overlap() {
        let windows = [win(
            1,
            "Elsewhere",
            Region {
                x: 0,
                y: 0,
                width: 50,
                height: 50,
            },
        )];
        let capture = [Region {
            x: 100,
            y: 100,
            width: 50,
            height: 50,
        }];
        assert_eq!(dominant_overlay_window(&windows, &capture), None);
    }

    #[test]
    fn freehand_attribution_region_clips_to_canvas() {
        let points = [(-5, -5), (10, 0), (0, 10)];
        let region = freehand_attribution_region(&points, 8, 8).unwrap();
        assert_eq!(
            region,
            Region {
                x: 0,
                y: 0,
                width: 8,
                height: 8
            }
        );
    }

    fn solid(w: u32, h: u32, rgba: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(w, h, image::Rgba(rgba))
    }

    #[test]
    fn encode_png_round_trips_pixels_and_alpha() {
        // The single encode site every mode now funnels through — a
        // regression here would silently change every saved capture.
        let mut img = solid(3, 2, [10, 20, 30, 255]);
        img.put_pixel(1, 1, image::Rgba([200, 100, 50, 0]));
        let bytes = encode_png(&img).expect("encode ok");
        let decoded = image::load_from_memory(&bytes)
            .expect("valid png")
            .to_rgba8();
        assert_eq!(decoded.dimensions(), (3, 2));
        assert_eq!(decoded.get_pixel(0, 0), &image::Rgba([10, 20, 30, 255]));
        assert_eq!(decoded.get_pixel(1, 1)[3], 0, "alpha survives the encode");
    }

    #[test]
    fn mask_freehand_keeps_inside_drops_outside() {
        let canvas = solid(20, 20, [255, 0, 0, 255]);
        // Right triangle (0,0)-(20,0)-(0,20): the interior is x + y < 20.
        let tri = [(0, 0), (20, 0), (0, 20)];
        let out = mask_freehand(&canvas, &tri, (0, 0), false, None).unwrap();
        assert_eq!(out.dimensions(), (20, 20));
        assert_eq!(
            out.get_pixel(2, 2),
            &image::Rgba([255, 0, 0, 255]),
            "a pixel inside the triangle keeps the source color, fully opaque"
        );
        assert_eq!(
            out.get_pixel(18, 18)[3],
            0,
            "a pixel outside the triangle is fully transparent"
        );
    }

    #[test]
    fn mask_freehand_rejects_short_path() {
        let canvas = solid(20, 20, [255, 0, 0, 255]);
        let err = mask_freehand(&canvas, &[(0, 0), (1, 1)], (0, 0), false, None).unwrap_err();
        assert!(matches!(err, AppError::Overlay(_)));
    }

    #[test]
    fn mask_brush_keeps_painted_feathers_and_drops_empty() {
        let canvas = solid(10, 10, [0, 128, 255, 255]);
        // 2×2 mask at (3,4): opaque, half, empty, empty.
        let mask = BrushMask {
            x: 3,
            y: 4,
            width: 2,
            height: 2,
            rle: vec![(255, 1), (128, 1), (0, 2)],
        };
        let out = mask_brush(&canvas, &mask, (0, 0), false, None).unwrap();
        assert_eq!(out.dimensions(), (2, 2));
        // Fully-painted pixel keeps the source color, fully opaque.
        assert_eq!(out.get_pixel(0, 0), &image::Rgba([0, 128, 255, 255]));
        // Half-coverage pixel feathers the alpha (255 * 128 / 255 = 128).
        assert_eq!(out.get_pixel(1, 0)[3], 128);
        // Unpainted pixels are fully transparent.
        assert_eq!(out.get_pixel(0, 1)[3], 0);
        assert_eq!(out.get_pixel(1, 1)[3], 0);
    }

    #[test]
    fn mask_brush_rejects_all_empty_mask() {
        let canvas = solid(10, 10, [0, 0, 0, 255]);
        let mask = BrushMask {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            rle: vec![(0, 4)],
        };
        let err = mask_brush(&canvas, &mask, (0, 0), false, None).unwrap_err();
        assert!(matches!(err, AppError::Overlay(_)));
    }

    #[test]
    fn mask_brush_rejects_bad_rle_length() {
        let canvas = solid(10, 10, [0, 0, 0, 255]);
        let mask = BrushMask {
            x: 0,
            y: 0,
            width: 2,
            height: 2,
            rle: vec![(255, 3)], // declares 4 px, supplies 3
        };
        assert!(mask_brush(&canvas, &mask, (0, 0), false, None).is_err());
    }

    #[test]
    fn composite_multi_area_stitches_on_white_with_gap() {
        let canvas = solid(30, 10, [255, 0, 0, 255]);
        let rects = [
            Region {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            Region {
                x: 20,
                y: 0,
                width: 10,
                height: 10,
            },
        ];
        let out = composite_multi_area(&canvas, &rects, (0, 0), false, None, 12).unwrap();
        // 10 (crop) + 12 (gap) + 10 (crop) = 32 wide; tallest crop = 10.
        assert_eq!(out.dimensions(), (32, 10));
        assert_eq!(
            out.get_pixel(0, 0),
            &image::Rgba([255, 0, 0, 255]),
            "first crop"
        );
        assert_eq!(
            out.get_pixel(22, 0),
            &image::Rgba([255, 0, 0, 255]),
            "second crop sits after the 12 px gap"
        );
        assert_eq!(
            out.get_pixel(15, 5),
            &image::Rgba([255, 255, 255, 255]),
            "the gap is white background"
        );
    }

    #[test]
    fn composite_multi_area_rejects_empty() {
        let canvas = solid(10, 10, [0, 0, 0, 255]);
        assert!(composite_multi_area(&canvas, &[], (0, 0), false, None, 12).is_err());
    }

    /// Opt-in timing probe for the overlay open path — NOT a CI test.
    ///
    /// The criterion suite can only measure the deterministic half of
    /// `show` (clone / encode / base64 over a synthetic canvas); the
    /// rest of the critical path is whatever the real machine's display
    /// stack costs, which no synthetic corpus can stand in for. Run it
    /// against the actual desktop when tuning:
    ///
    /// ```text
    /// cargo test -p clippity-services --lib overlay_show_path_timings -- --ignored --nocapture
    /// ```
    ///
    /// Prints timings and byte sizes only — nothing about the captured
    /// content is recorded, which is the same constraint the benchmark
    /// harness works under.
    #[test]
    #[ignore = "measures the real display stack; run manually when tuning the overlay path"]
    fn overlay_show_path_timings() {
        use std::time::Instant;

        let t = Instant::now();
        let (min_x, min_y, vw, vh) = virtual_bounds().expect("virtual bounds");
        println!("virtual_bounds          {:>8.2} ms  ({vw}x{vh})", ms(t));

        let t = Instant::now();
        let canvas = build_virtual_canvas().expect("canvas");
        println!("build_virtual_canvas    {:>8.2} ms", ms(t));

        // Reference only — `show` shares one buffer behind an `Arc`, so
        // this no longer happens. Kept so the saving stays visible, and
        // so anyone tempted to hand a consumer its own copy can see the
        // price first.
        let t = Instant::now();
        let copy = canvas.clone();
        println!(
            "(canvas.clone, avoided) {:>8.2} ms  ({} MiB)",
            ms(t),
            copy.as_raw().len() / (1024 * 1024)
        );

        let t = Instant::now();
        let windows = gather_windows(min_x, min_y, vw, vh, OverlayMode::Region);
        println!(
            "gather_windows          {:>8.2} ms  ({} windows)",
            ms(t),
            windows.len()
        );

        let t = Instant::now();
        let monitors = gather_monitors(min_x, min_y, vw, vh);
        println!(
            "gather_monitors         {:>8.2} ms  ({} monitors)",
            ms(t),
            monitors.len()
        );

        let t = Instant::now();
        let png = render_loupe_png(&canvas).expect("loupe png");
        println!(
            "render_loupe_png        {:>8.2} ms  ({} MiB served, not base64'd)",
            ms(t),
            png.len() / (1024 * 1024)
        );

        // The compositor half of `settle_after_hide` — the floor + flush.
        // The deterministic wait-for-hidden that precedes it needs a live
        // `AppHandle` (there is no window to hide here), so it can't be
        // measured from this probe; in the app it exits within a frame or
        // two of the hide landing.
        let t = Instant::now();
        std::thread::sleep(clippity_infra::config::compositor_unpaint_floor());
        window_service::wait_compositor_compose(clippity_infra::config::COMPOSITOR_SETTLE_FLUSHES);
        println!(
            "compositor settle       {:>8.2} ms  (floor {} ms + {} DwmFlush; wait-for-hidden not shown)",
            ms(t),
            clippity_infra::config::COMPOSITOR_UNPAINT_FLOOR_MS,
            clippity_infra::config::COMPOSITOR_SETTLE_FLUSHES
        );
    }

    fn ms(t: std::time::Instant) -> f64 {
        t.elapsed().as_secs_f64() * 1000.0
    }
}
