//! Capture orchestration. Owns the fullscreen capture pipeline:
//! hide the capture window briefly so it isn't in the shot, grab the
//! monitor under the cursor via xcap, encode PNG, persist to disk, cache
//! the result, optionally push to the clipboard, restore the window, and
//! emit `clippity://capture/finished`.
//!
//! Non-fullscreen `CaptureKind` variants reject with `Unsupported` —
//! they unblock as the overlay (port #2) and custom-mode ports land.

use std::sync::{Arc, Mutex};

use image::RgbaImage;
use tauri::AppHandle;
use xcap::Monitor;

use clippity_infra::events;
use clippity_domain::capture::{CaptureKind, CaptureRequest, CaptureResult, CustomMode};
use clippity_domain::enhance;
use clippity_domain::metadata::{self, CaptureSource};
use clippity_domain::settings::CaptureCompression;
use clippity_domain::window_attribution::{self, Rect as AttributionRect, WindowRect};
use clippity_infra::error::{AppError, AppResult};
use crate::capture_io::{
    copy_rgba_to_clipboard, next_id, resolve_save_dir, save_capture_png,
};
use crate::settings_service::{
    CaptureEncodingSource, CapturesDirSource, NameTemplateSource,
};
use crate::window_service;

/// Per-process capture state — currently just the most recent result
/// so a later port (library / toast) can read it through an inspector
/// command without re-capturing.
#[derive(Default)]
pub struct CaptureState {
    last: Option<CaptureResult>,
}

pub struct CaptureService {
    captures: Arc<dyn CapturesDirSource>,
    encoding: Arc<dyn CaptureEncodingSource>,
    naming: Arc<dyn NameTemplateSource>,
    state: Mutex<CaptureState>,
}

impl CaptureService {
    pub fn new(
        captures: Arc<dyn CapturesDirSource>,
        encoding: Arc<dyn CaptureEncodingSource>,
        naming: Arc<dyn NameTemplateSource>,
    ) -> Self {
        Self {
            captures,
            encoding,
            naming,
            state: Mutex::new(CaptureState::default()),
        }
    }

    /// Dispatch by `CaptureKind`. Fullscreen runs the full pipeline;
    /// other kinds return `Unsupported` until their port lands.
    pub fn execute(&self, app: &AppHandle, request: CaptureRequest) -> AppResult<CaptureResult> {
        check_supported(request.kind)?;
        self.execute_fullscreen(app, &request)
    }

    /// Inspector — last successful capture, if any. Unused in the
    /// MVP capture port; reserved for library / toast / editor.
    #[allow(dead_code)]
    pub fn last(&self) -> Option<CaptureResult> {
        self.state.lock().ok().and_then(|s| s.last.clone())
    }

    fn execute_fullscreen(
        &self,
        app: &AppHandle,
        request: &CaptureRequest,
    ) -> AppResult<CaptureResult> {
        // Fallback title captured before hiding our own windows. The
        // saved name prefers the visible majority window on the monitor,
        // but this keeps hotkey-triggered captures recognisable if live
        // window enumeration cannot attribute the pixels.
        let fallback_source = foreground_window_source();

        // Hide every primary window except the overlay (which is itself
        // hidden during a fullscreen capture). Sleeps the
        // capture-flavoured unpaint inside the helper.
        window_service::hide_capture_briefly(app);

        let grab = grab_active_monitor_image()?;
        let (mut image, monitor_x, monitor_y) = (grab.image, grab.x, grab.y);
        // Title *and* owning app come from the same attribution result,
        // so the name and the metadata record describe one window.
        let (source_window, source_app) =
            dominant_window_for_region(monitor_x, monitor_y, image.width(), image.height())
                .unwrap_or(fallback_source);

        // xcap's Windows.Graphics.Capture path explicitly excludes the
        // cursor — composite it on top when the user asked for it. The
        // None / None args use the system cursor's live position
        // (correct for fullscreen captures, where the entire monitor
        // is in-frame).
        if request.toggles.cursor {
            #[cfg(target_os = "windows")]
            clippity_platform::windows::cursor::composite_cursor(
                &mut image, monitor_x, monitor_y, None, None,
            );
            #[cfg(not(target_os = "windows"))]
            {
                let _ = (monitor_x, monitor_y);
            }
        }

        // Smart enhance, when asked for, runs before the encode so the
        // file and the clipboard copy below are the same pixels — the
        // overlay pipeline sequences it the same way.
        if request.toggles.enhance {
            enhance::smart_enhance(&mut image);
        }

        let png = encode_png(&image, self.encoding.capture_compression())?;
        // Presets may pin a save dir via `request.output_dir`; otherwise
        // use the live captures dir from settings.
        let dir = resolve_save_dir(request.output_dir.as_deref(), self.captures.captures_dir());
        // This pipeline grabs one whole monitor, so there is nothing to
        // attribute — the display it captured *is* the display it came
        // from.
        let source = CaptureSource::from_mode("Fullscreen")
            .with_window(source_window.as_deref(), source_app.as_deref())
            .with_size(png.width, png.height)
            .with_monitor(grab.monitor.as_deref())
            .with_preset(request.preset.as_deref());
        let path = save_capture_png(&dir, &png.bytes, &self.naming.name_template(), &source)?;

        let result = CaptureResult {
            id: next_id(),
            kind: request.kind,
            custom_mode: request.custom_mode,
            width: png.width,
            height: png.height,
            path: path.to_string_lossy().into_owned(),
            preview: request.toggles.preview,
        };

        tracing::info!(
            id = %result.id,
            path = %result.path,
            width = result.width,
            height = result.height,
            bytes = png.bytes.len(),
            "fullscreen capture saved"
        );

        if request.toggles.clipboard {
            // Push the RGBA we already have — no PNG re-decode. (The png
            // bytes are still what we persisted above.)
            if let Err(e) = copy_rgba_to_clipboard(&image) {
                // Clipboard failure shouldn't fail the capture itself —
                // the file is on disk; surface to logs and continue.
                tracing::warn!("clipboard copy failed: {e}");
            }
        }

        {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| AppError::Capture("capture state lock poisoned".into()))?;
            guard.last = Some(result.clone());
        }

        // Bring the window back *before* the event so listeners see a
        // painted capture window (avoids a brief blank frame on focus).
        window_service::restore_window(app, "capture");

        // Tell the library to refresh — best-effort, the capture
        // succeeded regardless of whether the event fires.
        let _ = events::emit(app, events::names::LIBRARY_UPDATED, ());
        events::emit(app, events::names::CAPTURE_FINISHED, result.clone())?;
        Ok(result)
    }

    /// Persist a clipboard bitmap as a file-backed capture (Clipboard
    /// custom mode, image branch). Reuses `execute_fullscreen`'s encode →
    /// save → cache → emit tail, minus the screenshot grab, the
    /// window-hide dance, and the clipboard copy-back (the image is
    /// already on the clipboard — that's where it came from). Emits
    /// `library/updated` + `capture/finished` so the library refreshes and
    /// the preview-in-editor listener can open the editor on the new PNG.
    pub fn save_clipboard_image(
        &self,
        app: &AppHandle,
        image: &RgbaImage,
        preview: bool,
    ) -> AppResult<CaptureResult> {
        let png = encode_png(image, self.encoding.capture_compression())?;
        let dir = resolve_save_dir(None, self.captures.captures_dir());
        // No source window, and no screen of origin either — the image
        // came from the clipboard, not off a display. The name falls back
        // to the "Clipboard" type label and the metadata record carries
        // the mode + dimensions only.
        let source =
            CaptureSource::from_mode("Clipboard").with_size(png.width, png.height);
        let path = save_capture_png(&dir, &png.bytes, &self.naming.name_template(), &source)?;

        let result = CaptureResult {
            id: next_id(),
            kind: CaptureKind::Custom,
            custom_mode: Some(CustomMode::Clipboard),
            width: png.width,
            height: png.height,
            path: path.to_string_lossy().into_owned(),
            preview,
        };

        tracing::info!(
            id = %result.id,
            path = %result.path,
            width = result.width,
            height = result.height,
            bytes = png.bytes.len(),
            "clipboard image capture saved"
        );

        {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| AppError::Capture("capture state lock poisoned".into()))?;
            guard.last = Some(result.clone());
        }

        let _ = events::emit(app, events::names::LIBRARY_UPDATED, ());
        events::emit(app, events::names::CAPTURE_FINISHED, result.clone())?;
        Ok(result)
    }
}

/// The attributed source of a capture: `(window title, application)`,
/// either of which can be absent. Kept as a pair so a caller can't
/// accidentally pick the title from one window and the app from
/// another.
type AttributedSource = (Option<String>, Option<String>);

/// The focused window for fallback file naming — `(None, None)` when it
/// can't be resolved (no foreground window, blank title, or it's our
/// own window). Windows-only; other targets always get the empty pair.
fn foreground_window_source() -> AttributedSource {
    #[cfg(target_os = "windows")]
    {
        match clippity_platform::windows::enumeration::foreground_window_source() {
            Some((title, app)) => (Some(title), non_blank(app)),
            None => (None, None),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        (None, None)
    }
}

fn dominant_window_for_region(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Option<AttributedSource> {
    #[cfg(target_os = "windows")]
    {
        let windows = clippity_platform::windows::enumeration::list_capturable_windows();
        let window_rects: Vec<_> = windows
            .iter()
            .map(|w| WindowRect {
                title: w.title.as_str(),
                app: w.app.as_str(),
                rect: AttributionRect {
                    x: w.x,
                    y: w.y,
                    width: w.width,
                    height: w.height,
                },
            })
            .collect();
        let capture = [AttributionRect {
            x,
            y,
            width,
            height,
        }];
        window_attribution::dominant_window(&window_rects, &capture)
            .map(|w| (Some(w.title.to_owned()), non_blank(w.app.to_owned())))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (x, y, width, height);
        None
    }
}

/// An unresolved process name arrives as `""`; the metadata record and
/// the `{app}` token both mean "absent" by that, so normalise once here.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn non_blank(s: String) -> Option<String> {
    (!s.trim().is_empty()).then_some(s)
}

/// Pure: which `CaptureKind` variants the MVP port can fulfill.
///
/// Extracted so the unit test below can exercise the dispatch decision
/// without spinning up a Tauri app, an xcap Monitor, or the filesystem.
fn check_supported(kind: CaptureKind) -> AppResult<()> {
    match kind {
        CaptureKind::Fullscreen => Ok(()),
        CaptureKind::Region | CaptureKind::Window | CaptureKind::Custom => {
            Err(AppError::Unsupported("capture mode not yet ported"))
        }
    }
}

struct EncodedPng {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

/// The system cursor's position in screen coordinates, or `None` where
/// there is no way to ask. Mirrors the recorder's helper of the same
/// name — both resolve "which screen does Fullscreen mean?" and must
/// answer it identically.
#[cfg(target_os = "windows")]
fn cursor_position() -> Option<(i32, i32)> {
    clippity_platform::windows::cursor::screen_position()
}

#[cfg(not(target_os = "windows"))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

/// Tone-mapped RGBA for the monitor at a screen point, when that
/// monitor is running in HDR. `None` means "use the ordinary grab" —
/// see `platform::windows::hdr_capture`.
///
/// The point is nudged one pixel inside the monitor's origin: the
/// top-left corner is shared with the monitor above/left of it on a
/// multi-monitor desktop, and `MonitorFromPoint` would be free to
/// resolve it to the neighbour.
#[cfg(target_os = "windows")]
fn hdr_grab_at(x: i32, y: i32) -> Option<RgbaImage> {
    clippity_platform::windows::hdr_capture::rgba_monitor_at(x + 1, y + 1)
}

#[cfg(not(target_os = "windows"))]
fn hdr_grab_at(_x: i32, _y: i32) -> Option<RgbaImage> {
    None
}

/// One monitor's pixels plus what we know about the monitor itself.
struct MonitorGrab {
    image: RgbaImage,
    /// Virtual-screen origin, so the cursor compositor can convert the
    /// system cursor's screen position into image-local coordinates.
    x: i32,
    y: i32,
    /// Display label for the provenance record, or `None` when the
    /// device name couldn't be read — a missing label costs a metadata
    /// field, never the capture.
    monitor: Option<String>,
}

/// Grab the monitor the user is currently looking at — the one under
/// the cursor — falling back to the primary when there is no cursor to
/// read or no monitor under it.
///
/// The cursor, not the primary, because Fullscreen means "this screen"
/// and on a multi-monitor desk the screen the user means is the one
/// they are pointing at. Shooting the primary instead is invisible on a
/// single display and wrong on every other setup; it is also what
/// `RecorderService::start` already assumed the still path did — its
/// comment says fullscreen recording resolves to the cursor's monitor
/// "matching where the still Fullscreen mode shoots", which was true of
/// the intent and not of the code. Now both modes frame the same
/// rectangle, so a screenshot and a recording of "fullscreen" can't
/// disagree about which screen that is.
fn grab_active_monitor_image() -> AppResult<MonitorGrab> {
    let monitor = match cursor_position().and_then(|(x, y)| Monitor::from_point(x, y).ok()) {
        Some(m) => m,
        None => {
            let monitors = Monitor::all().map_err(|e| AppError::Capture(e.to_string()))?;
            monitors
                .into_iter()
                .min_by_key(|m| usize::from(!m.is_primary().unwrap_or(false)))
                .ok_or_else(|| AppError::Capture("no monitor found".into()))?
        }
    };
    let mx = monitor.x().map_err(|e| AppError::Capture(e.to_string()))?;
    let my = monitor.y().map_err(|e| AppError::Capture(e.to_string()))?;
    let label = monitor
        .name()
        .ok()
        .and_then(|name| metadata::monitor_label(&name));
    // An HDR display's desktop is composed in scRGB, and asking xcap
    // for 8-bit pixels gets it flattened by a conversion that never
    // saw the display's white level — the washed-out HDR screenshot.
    // `None` covers both "this display is SDR" and "the float path
    // wasn't available", and both mean the same thing here.
    let image: RgbaImage = match hdr_grab_at(mx, my) {
        Some(image) => image,
        None => monitor
            .capture_image()
            .map_err(|e| AppError::Capture(e.to_string()))?,
    };
    Ok(MonitorGrab {
        image,
        x: mx,
        y: my,
        monitor: label,
    })
}

/// Encode `image` to PNG at the requested effort. The compression knob
/// trades capture-save CPU against file size; `Balanced` reproduces the
/// historic `DynamicImage::write_to(Png)` default (deflate `Default` +
/// adaptive filtering) so unchanged settings encode identically.
fn encode_png(image: &RgbaImage, compression: CaptureCompression) -> AppResult<EncodedPng> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};

    let (width, height) = (image.width(), image.height());
    let (compression_type, filter) = match compression {
        // Fastest deflate, no per-row filtering — least CPU, biggest file.
        CaptureCompression::Fast => (CompressionType::Fast, FilterType::NoFilter),
        // The historic default.
        CaptureCompression::Balanced => (CompressionType::Default, FilterType::Adaptive),
        // Maximum deflate effort + adaptive filtering — smallest file.
        CaptureCompression::Small => (CompressionType::Best, FilterType::Adaptive),
    };

    let mut bytes = Vec::new();
    PngEncoder::new_with_quality(std::io::Cursor::new(&mut bytes), compression_type, filter)
        .write_image(image.as_raw(), width, height, ExtendedColorType::Rgba8)
        .map_err(|e| AppError::Capture(format!("png encode: {e}")))?;

    Ok(EncodedPng {
        bytes,
        width,
        height,
    })
}

// Post-capture PNG / clipboard / id helpers live in
// `services::capture_io` — promoted there once the overlay port made
// them dual-consumer.
//
// Window-lifecycle primitives (hide / restore / sleep) live in
// `services::window_service` — promoted on the same trigger during the
// overlay port.

#[cfg(test)]
mod tests {
    use super::*;
    use clippity_domain::capture::CustomMode;

    #[test]
    fn fullscreen_is_supported() {
        assert!(check_supported(CaptureKind::Fullscreen).is_ok());
    }

    #[test]
    fn region_is_unsupported() {
        let err = check_supported(CaptureKind::Region).unwrap_err();
        assert_eq!(err.code(), "unsupported");
    }

    #[test]
    fn window_is_unsupported() {
        let err = check_supported(CaptureKind::Window).unwrap_err();
        assert_eq!(err.code(), "unsupported");
    }

    #[test]
    fn custom_is_unsupported() {
        let err = check_supported(CaptureKind::Custom).unwrap_err();
        assert_eq!(err.code(), "unsupported");
    }

    // Sanity: CustomMode is a `Copy` enum we can pass through requests.
    #[test]
    fn custom_mode_copies() {
        let m = CustomMode::PaletteCapture;
        let n = m;
        assert_eq!(m, n);
    }
}
