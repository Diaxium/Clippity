//! Tauri `#[command]` handlers.
//!
//! New commands are added here and registered in `lib.rs` via
//! `tauri::generate_handler!`. Keep each handler thin — the
//! convention is: parse → delegate to a service → return.

use crate::app::state::AppState;
use clippity_domain::capture::{CaptureRequest, CaptureResult, ClipboardIngest};
use clippity_domain::collections::Collection;
use clippity_domain::countdown::CountdownRequest;
use clippity_domain::dashboard::{DashboardRequest, DashboardView};
use clippity_domain::developer::{
    self, BundleOptions, BundleResult, CacheTarget, FolderTarget, LogLine, RecorderDiagnostics,
    RuntimeStatus, SystemInfo, WindowDiagnostics,
};
use clippity_domain::editor::EditorImage;
use clippity_domain::labels::LabelEdit;
use clippity_domain::library::{AuxColor, CaptureKind, CaptureMeta, StorageInfo};
use clippity_domain::media::{MediaInfo, TrimRequest, TrimResult};
use clippity_domain::models::{ModelInfo, ModelPhase, ObjectModelReadiness, ReleaseCheck};
use clippity_domain::overlay::{
    BeginOverlayRequest, FinishBrushRequest, FinishFreehandRequest, FinishMultiAreaRequest,
    FinishRegionRequest, OverlayMode, OverlayResult, OverlayToggles, OverlayWindow, Region,
};
use clippity_domain::preset::{CapturePreset, PresetInput};
use clippity_domain::provisioning::Capabilities;
use clippity_domain::recorder::{
    AudioSource, RecorderFormat, RecorderRequest, RecorderResult, RecorderStatus,
};
use clippity_domain::scroll::ScrollDirection;
use clippity_domain::settings::{BackdropTuning, Settings, SettingsPatch, WindowBackdrop};
use clippity_domain::share::ShareTarget;
use clippity_domain::toast::{
    PaletteSwatch, PickedColor, RecorderToastFormat, RecordingMode, ToastPayload,
};
use clippity_domain::vision::DetectedObject;
use clippity_infra::error::{AppError, AppResult};
use clippity_infra::events;
use serde::Serialize;

use clippity_services::capture_io::{self, ClipboardContent};
use clippity_services::share_service;
use clippity_services::window_service;

/// Refusal for a Grab-Text request on an install whose OCR engine was
/// declined. Named so the overlay-open and the finalize path can't drift
/// into telling the user two different stories about the same choice.
const OCR_DECLINED: AppError =
    AppError::NotInstalled("the OCR engine was not selected when Clippity was installed");

/// Refusal for a GIF recording on an install whose GIF encoder was declined.
const GIF_DECLINED: AppError =
    AppError::NotInstalled("the GIF encoder was not selected when Clippity was installed");

/// Liveness probe used by the frontend boot sequence to confirm the
/// Tauri bridge is up before mounting the rest of the app.
#[tauri::command]
pub fn ping() -> AppResult<&'static str> {
    Ok("pong")
}

/// Snap the primary monitor and persist the PNG. Returns a
/// `CaptureResult` whose `path` field points at the on-disk file.
/// Also emits `clippity://capture/finished` with the same payload so
/// other windows (toast, library, editor) can react without polling.
#[tauri::command]
pub fn capture_fullscreen(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: CaptureRequest,
) -> AppResult<CaptureResult> {
    state.capture_service.execute(&app, request)
}

/// Re-apply (or strip) the native backdrop with the frontend's persisted
/// theme + transparency preference. Each primary window mirrors the
/// React palette, so this fires on mount + every theme flip to keep the
/// material tint in sync; `effects` carries `performance.window_effects`
/// so the same call clears the backdrop when the user has turned
/// transparency off. `tuning` is the selected material's own
/// fine-tuning — the frontend resolves it out of
/// `appearance.backdropTuning` so this command stays one material wide.
/// No-op on non-Windows targets.
#[tauri::command]
pub fn apply_window_theme(
    #[allow(unused_variables)] app: tauri::AppHandle,
    #[allow(unused_variables)] theme: String,
    #[allow(unused_variables)] effects: bool,
    #[allow(unused_variables)] backdrop: WindowBackdrop,
    #[allow(unused_variables)] tuning: BackdropTuning,
) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    clippity_platform::windows::chrome::refresh_backdrop(
        &app,
        theme == "dark",
        effects,
        backdrop,
        tuning.clamped(),
    );
    Ok(())
}

/// Colour app-icon tile (full-colour mark on a dark rounded square).
/// Embedded at build time so the runtime swap needs no disk read.
const APP_ICON_COLOR_PNG: &[u8] = include_bytes!("../../icons/tray-color.png");
/// Monochrome app-icon tile (grayscale mark on a dark rounded square).
const APP_ICON_MONO_PNG: &[u8] = include_bytes!("../../icons/tray-mono.png");

/// Stable id of the system-tray icon. Kept in lock-step with
/// `tray_service::build` (`TrayIconBuilder::with_id`).
const TRAY_ICON_ID: &str = "clippity-tray";

/// Swap the running process's icons to the chosen style. Applies the
/// selected mark to the system-tray icon and every open window's taskbar
/// icon at runtime — the frontend fires this on mount and whenever
/// `appearance.appIcon` changes, mirroring the `apply_window_theme`
/// pattern. The built *executable* icon can't change at runtime, so this
/// covers exactly the icons the running process owns.
///
/// Best-effort: a decode / set failure is logged and swallowed rather
/// than surfaced as a recoverable UI error (matches `apply_window_theme`).
#[tauri::command]
pub fn apply_app_icon(app: tauri::AppHandle, style: String) -> AppResult<()> {
    use tauri::Manager;

    let bytes = match style.as_str() {
        "monochrome" => APP_ICON_MONO_PNG,
        // Any unknown/legacy value falls back to the colour default.
        _ => APP_ICON_COLOR_PNG,
    };

    let icon = tauri::image::Image::from_bytes(bytes)
        .map_err(|e| AppError::Settings(format!("app icon decode: {e}")))?;

    // Tray icon. Absent only if the tray failed to build (non-fatal).
    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        if let Err(e) = tray.set_icon(Some(icon.clone())) {
            tracing::warn!("app icon: could not set tray icon: {e}");
        }
    }

    // Per-window taskbar icons. Overlay/countdown/toast/tray are
    // chromeless and never surface a taskbar icon, but setting them is
    // harmless — the OS simply ignores it for those.
    for (label, window) in app.webview_windows() {
        if let Err(e) = window.set_icon(icon.clone()) {
            tracing::warn!("app icon: could not set '{label}' window icon: {e}");
        }
    }

    Ok(())
}

/// Open the region-selection overlay for `mode`. Hides other primary
/// windows, snapshots the desktop, positions + shows the pre-declared
/// overlay window, emits `clippity://overlay/shown`.
#[tauri::command]
pub fn begin_region_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: BeginOverlayRequest,
) -> AppResult<()> {
    // Region + Window + the ported custom modes (Freehand, Multi-Area,
    // Color-Pick, Palette, Grab-Text, Scrolling, Object). The remaining
    // overlay modes reject with Unsupported so the frontend can surface
    // the deferral cleanly.
    if !matches!(
        request.mode,
        OverlayMode::Region
            | OverlayMode::Window
            | OverlayMode::Freehand
            | OverlayMode::MultiArea
            | OverlayMode::ColorPick
            | OverlayMode::Palette
            | OverlayMode::GrabText
            | OverlayMode::Scrolling
            | OverlayMode::Object
            | OverlayMode::Panoramic
            | OverlayMode::RecordRegion
            | OverlayMode::RecordWindow
    ) {
        return Err(AppError::Unsupported("overlay mode not yet ported"));
    }
    // Refused here as well as hidden in the UI: the overlay is reachable
    // from a preset, a hotkey, and the tray, so the UI's own gating is not a
    // complete answer.
    if matches!(request.mode, OverlayMode::GrabText)
        && !state.provisioning_service.capabilities().text_recognition
    {
        return Err(OCR_DECLINED);
    }
    state
        .overlay_service
        .show(&app, request.mode, request.output_dir, request.preset)
}

/// Switch the active selection method on the open overlay session in
/// place (Rectangle / Freehand / Pen / Magnetic Lasso / Brush all share
/// the same cached snapshot). Updates only the session mode so the saved
/// file is labelled after the method the user actually drew — no
/// re-snapshot. No-op when no overlay session is open.
#[tauri::command]
pub fn set_overlay_mode(state: tauri::State<'_, AppState>, mode: OverlayMode) -> AppResult<()> {
    state.overlay_service.set_mode(mode)
}

/// Cancel the overlay without producing a capture. Hides the overlay
/// window and restores the capture window.
#[tauri::command]
pub fn cancel_region_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    state.overlay_service.cancel(&app)
}

/// Finalize a Region selection: crop the cached snapshot to `rect`,
/// optionally composite the cursor at `cursorPin`, save the PNG,
/// optionally copy to clipboard, emit `clippity://capture/finished`.
#[tauri::command]
pub fn finish_region_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: FinishRegionRequest,
) -> AppResult<OverlayResult> {
    state.overlay_service.finish_region(&app, request)
}

/// Fullscreen capture taken from inside the overlay (`F` / the
/// Fullscreen tab). Crops the monitor the cursor is on out of the cached
/// snapshot — the frozen backdrop the user is looking at — rather than
/// closing the overlay and re-grabbing the screen. Saves, optionally
/// copies to clipboard, emits `clippity://capture/finished`.
#[tauri::command]
pub fn finish_fullscreen_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    toggles: OverlayToggles,
) -> AppResult<OverlayResult> {
    state.overlay_service.finish_fullscreen(&app, toggles)
}

/// Hand an already-saved capture to the OS: reveal it in the file
/// manager, open it with the registered default app, or copy its
/// absolute path to the clipboard. Nothing leaves the machine — see
/// `domain::share::ShareTarget`.
///
#[tauri::command]
pub fn share_capture(path: String, target: ShareTarget) -> AppResult<()> {
    share_service::share(std::path::Path::new(&path), target)
}

/// Finalize a Freehand (lasso) selection: mask everything outside the
/// drawn polygon to transparent, crop to the path's bounding box, save,
/// optionally copy to clipboard, emit `clippity://capture/finished`.
#[tauri::command]
pub fn finish_freehand_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: FinishFreehandRequest,
) -> AppResult<OverlayResult> {
    state.overlay_service.finish_freehand(&app, request)
}

/// Finalize a Brush selection: composite the cached snapshot through the
/// painted alpha mask, crop to the mask's bounding box, save, optionally
/// copy to clipboard, emit `clippity://capture/finished`.
#[tauri::command]
pub fn finish_brush_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: FinishBrushRequest,
) -> AppResult<OverlayResult> {
    state.overlay_service.finish_brush(&app, request)
}

/// Finalize a Multi-Area selection: crop every rect and stitch them
/// horizontally on a white background, save, optionally copy to
/// clipboard, emit `clippity://capture/finished`.
#[tauri::command]
pub fn finish_multi_area_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: FinishMultiAreaRequest,
) -> AppResult<OverlayResult> {
    state.overlay_service.finish_multi_area(&app, request)
}

/// Color-Picker mode: sample the pixel at `(x, y)` (canvas-local
/// physical px) from the cached snapshot, copy its `#RRGGBB` hex to the
/// clipboard, and surface the result as a `color` toast. Returns the
/// sampled color. Not a capture — no file, no `capture/finished`.
#[tauri::command]
pub fn pick_color(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    x: u32,
    y: u32,
) -> AppResult<PickedColor> {
    let color = state.overlay_service.pick_color(&app, x, y)?;
    // Persist a `color` library entry (aux catalog) + refresh the library.
    // Best-effort — the hex is already on the clipboard.
    let aux = AuxColor {
        hex: color.hex.clone(),
        r: color.r,
        g: color.g,
        b: color.b,
        // A single sampled pixel has no palette share.
        proportion: None,
    };
    if let Err(e) = state.library_service.add_color(aux) {
        tracing::warn!("color-pick library persist failed: {e}");
    } else {
        let _ = events::emit(&app, events::names::LIBRARY_UPDATED, ());
    }
    // Surface the pick as a bottom-right toast. Best-effort — the hex is
    // already on the clipboard, so a toast failure shouldn't fail the pick.
    if let Err(e) = state.toast_service.show(
        &app,
        ToastPayload::Color {
            color: color.clone(),
        },
    ) {
        tracing::warn!("color-pick toast failed: {e}");
    }
    Ok(color)
}

/// Palette-Capture mode: crop the selected `rect`, quantize it, persist a
/// `palette` library entry, and surface a palette toast (preview +
/// swatches). The swatch `count` comes from the IPC arg when present
/// (clamped), else from the user's configured `capture.paletteCount`
/// setting (default 6). Returns the persisted entry. Not a file capture —
/// no `capture/finished`.
#[tauri::command]
pub fn finish_palette_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    rect: Region,
    count: Option<usize>,
) -> AppResult<CaptureMeta> {
    // Explicit override → clamp it; otherwise fall back to the configured
    // (already-clamped) default. Never trust a raw client-supplied count.
    let count = match count {
        Some(n) => clippity_domain::palette::clamp_count(n),
        None => state.settings_service.palette_count(),
    };
    let (preview, colors) = state.overlay_service.finish_palette(&app, rect, count)?;
    let entry = state.library_service.add_palette(colors.clone())?;
    let _ = events::emit(&app, events::names::LIBRARY_UPDATED, ());
    // Best-effort palette toast (preview thumbnail + swatch strip). Carry
    // each swatch's proportion through so the toast can size + label them.
    let swatches: Vec<PaletteSwatch> = colors
        .iter()
        .map(|c| PaletteSwatch {
            r: c.r,
            g: c.g,
            b: c.b,
            hex: c.hex.clone(),
            proportion: c.proportion,
        })
        .collect();
    if let Err(e) = state.toast_service.show(
        &app,
        ToastPayload::Palette {
            preview,
            colors: swatches,
        },
    ) {
        tracing::warn!("palette toast failed: {e}");
    }
    Ok(entry)
}

/// Grab-Text mode: crop the selected `rect`, OCR it (Windows.Media.Ocr),
/// copy the text to the clipboard (in the service), persist a `text`
/// library entry, and surface a text toast. Returns the recognized
/// text. `Err(ocr)` when the region has no readable text. Not a file
/// capture — no `capture/finished`.
#[tauri::command]
pub fn finish_grab_text_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    rect: Region,
) -> AppResult<String> {
    if !state.provisioning_service.capabilities().text_recognition {
        return Err(OCR_DECLINED);
    }
    let text = state.overlay_service.finish_grab_text(&app, rect)?;
    if let Err(e) = state.library_service.add_text(text.clone()) {
        tracing::warn!("grab-text library persist failed: {e}");
    } else {
        let _ = events::emit(&app, events::names::LIBRARY_UPDATED, ());
    }
    if let Err(e) = state
        .toast_service
        .show(&app, ToastPayload::Text { text: text.clone() })
    {
        tracing::warn!("grab-text toast failed: {e}");
    }
    Ok(text)
}

/// Longest-edge cap (physical px) for the Clipboard-image toast preview
/// thumbnail — the toast shows it at ~56 px, so 96 leaves headroom for
/// HiDPI without shipping the full bitmap through the event channel.
const CLIPBOARD_PREVIEW_MAX_EDGE: u32 = 96;

/// Clipboard custom mode: ingest whatever the system clipboard holds.
/// Unlike every other custom mode this opens **no** overlay — the data
/// already exists. An image is saved as a file-backed capture (and
/// emits `capture/finished`, so the "Preview in Editor" toggle opens the
/// editor like any other capture); text is persisted as an aux library
/// entry (same as Grab-Text); an empty clipboard is a no-op the frontend
/// turns into a friendly "copy something first" toast. Image + text both
/// raise a `clipboard` toast. `preview` rides through to the saved
/// capture's `preview` flag (image branch only).
#[tauri::command]
pub fn ingest_clipboard(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    preview: bool,
) -> AppResult<ClipboardIngest> {
    match capture_io::read_clipboard()? {
        ClipboardContent::Image(image) => {
            let capture = state
                .capture_service
                .save_clipboard_image(&app, &image, preview)?;
            // Best-effort toast — the capture is already saved + emitted.
            if let Err(e) = state.toast_service.show(
                &app,
                ToastPayload::Clipboard {
                    preview: capture_io::thumbnail_data_uri(&image, CLIPBOARD_PREVIEW_MAX_EDGE),
                    width: capture.width,
                    height: capture.height,
                    text: None,
                },
            ) {
                tracing::warn!("clipboard image toast failed: {e}");
            }
            Ok(ClipboardIngest::Image { capture })
        }
        ClipboardContent::Text(text) => {
            // Aux text entry (no file) + library refresh — mirrors Grab-Text.
            if let Err(e) = state.library_service.add_text(text.clone()) {
                tracing::warn!("clipboard text library persist failed: {e}");
            } else {
                let _ = events::emit(&app, events::names::LIBRARY_UPDATED, ());
            }
            if let Err(e) = state.toast_service.show(
                &app,
                ToastPayload::Clipboard {
                    preview: String::new(),
                    width: 0,
                    height: 0,
                    text: Some(text.clone()),
                },
            ) {
                tracing::warn!("clipboard text toast failed: {e}");
            }
            Ok(ClipboardIngest::Text { text })
        }
        ClipboardContent::Empty => Ok(ClipboardIngest::Empty),
    }
}

/// Start a Scrolling-Window recording: begin the capture worker (which
/// hides the overlay so the user can scroll) and show the recording HUD
/// — a sticky `Recording` toast excluded from capture so it never lands
/// in a frame. The user scrolls; `stop_scroll_capture` commits/discards.
#[tauri::command]
pub fn start_scroll_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    rect: Region,
    direction: ScrollDirection,
    clipboard: bool,
    preview: bool,
) -> AppResult<()> {
    state
        .scroll_capture_service
        .start(&app, rect, direction, false, clipboard, preview)?;
    state.toast_service.show(
        &app,
        ToastPayload::Recording {
            mode: RecordingMode::Scrolling,
            frames: 0,
        },
    )?;
    state.toast_service.set_capture_excluded(&app, true);
    Ok(())
}

/// Start a Panoramic (auto-scroll) capture: like Scrolling, but the
/// worker drives the scroll itself — it parks the cursor over the region
/// and sends wheel input each tick, capturing persistently until the
/// content stops advancing (end reached) or the user stops. Shows the
/// same recording HUD (in Panoramic mode) and excludes it from capture.
#[tauri::command]
pub fn start_panoramic_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    rect: Region,
    direction: ScrollDirection,
    clipboard: bool,
    preview: bool,
) -> AppResult<()> {
    state
        .scroll_capture_service
        .start(&app, rect, direction, true, clipboard, preview)?;
    state.toast_service.show(
        &app,
        ToastPayload::Recording {
            mode: RecordingMode::Panoramic,
            frames: 0,
        },
    )?;
    state.toast_service.set_capture_excluded(&app, true);
    Ok(())
}

/// Stop a Scrolling-Window recording. `discard` throws the frames away;
/// otherwise they're stitched + saved and `library/updated` +
/// `capture/finished` fire. Always tears down the HUD (un-excludes +
/// hides the toast). Returns the saved capture, or `None`.
#[tauri::command]
pub fn stop_scroll_capture(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    discard: bool,
) -> AppResult<Option<OverlayResult>> {
    let result = state.scroll_capture_service.stop(&app, discard)?;
    // The HUD's exclusion is *not* cleared here: every Clippity window is
    // capture-shielded for the whole session at startup
    // (`capture_shield::shield_windows`), so clearing it would leave the
    // toast the one un-shielded window from the first recording onward —
    // free to appear in every later grab.
    let _ = state.toast_service.hide(&app);
    if let Some(ref res) = result {
        let _ = events::emit(&app, events::names::LIBRARY_UPDATED, ());
        events::emit(&app, events::names::CAPTURE_FINISHED, res.clone())?;
    }
    Ok(result)
}

/// Start a video / GIF recording (ADR 0031) and raise the recorder HUD
/// — a sticky toast, excluded from capture so it never lands in a
/// frame. Returns the opening status so the HUD renders before the
/// first `recorder/tick`.
///
/// The HUD is torn down by `stop_recording`, whichever path reaches it
/// (the user's Stop button, or a duration limit the worker hit).
#[tauri::command]
pub fn start_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: RecorderRequest,
) -> AppResult<RecorderStatus> {
    // Refused before the session starts, not after: a recording that dies at
    // encode time has already cost the user the take.
    if matches!(request.format, RecorderFormat::Gif)
        && !state.provisioning_service.capabilities().gif_recording
    {
        return Err(GIF_DECLINED);
    }
    let format = match request.format {
        RecorderFormat::Mp4 => RecorderToastFormat::Mp4,
        RecorderFormat::Gif => RecorderToastFormat::Gif,
    };
    // Gated on the format, not just on the request: `validate` empties
    // the selection for a format that can't carry audio, so reading the
    // raw request would put a microphone row on a GIF session's HUD for
    // a track nothing is writing.
    let carries_audio = request.format.supports_audio();
    let microphone = carries_audio && request.audio.microphone;
    let system = carries_audio && request.audio.system;

    // A region / window recording is started *from* the overlay, which
    // must come down the instant the session does — left up it keeps
    // swallowing clicks and reads as still selecting. Dismissing hands
    // back the primary window it hid, which the recorder puts back on
    // stop rather than now: the user is about to record that screen.
    // A no-op (and `None`) when no overlay session was open, which is
    // every launcher-started recording.
    let restore_on_stop = state.overlay_service.dismiss(&app)?;

    let status = state
        .recorder_service
        .start(&app, request, restore_on_stop)?;
    // Only raise the HUD once the session is genuinely running — a
    // failed start must not leave a stop-button toast on screen with no
    // session behind it.
    state.toast_service.show(
        &app,
        ToastPayload::Recorder {
            format,
            microphone,
            system,
        },
    )?;
    state.toast_service.set_capture_excluded(&app, true);
    Ok(status)
}

/// Hold a running recording. The file's timeline has no gap — the
/// session clock stops rather than recording a frozen stretch.
#[tauri::command]
pub fn pause_recording(state: tauri::State<'_, AppState>) -> AppResult<RecorderStatus> {
    state.recorder_service.pause()
}

#[tauri::command]
pub fn resume_recording(state: tauri::State<'_, AppState>) -> AppResult<RecorderStatus> {
    state.recorder_service.resume()
}

/// Current session status. Lets a HUD that mounted late (or reloaded)
/// catch up without waiting for the next tick.
#[tauri::command]
pub fn recording_status(state: tauri::State<'_, AppState>) -> AppResult<RecorderStatus> {
    Ok(state.recorder_service.status())
}

/// Set one input's level on the running session, as a percentage of
/// unity (clamped backend-side by `recorder::clamp_gain_pct`).
///
/// Infallible by design, unlike `pause_recording`: this is a slider, and
/// a drag that lands just after the session ended is a race, not a
/// caller bug. Turning it into an error would put a toast on screen
/// about a recording that is already finished.
///
/// Affects the live session only — the persisted default lives in
/// Settings → Recording.
#[tauri::command]
pub fn set_recording_gain(state: tauri::State<'_, AppState>, source: AudioSource, pct: u16) {
    state.recorder_service.set_gain(source, pct);
}

/// Mute or unmute one input on the running session, restoring its
/// previous level on unmute. Same infallibility as
/// [`set_recording_gain`].
#[tauri::command]
pub fn set_recording_mute(state: tauri::State<'_, AppState>, source: AudioSource, muted: bool) {
    state.recorder_service.set_muted(source, muted);
}

/// Stop a recording. `discard` deletes the working file; otherwise it
/// is promoted into the captures directory and `recorder/finished` +
/// `library/updated` fire. Always tears the HUD down, including on
/// failure — a session that ended badly still has to release the
/// screen.
#[tauri::command]
pub fn stop_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    discard: bool,
) -> AppResult<Option<RecorderResult>> {
    let result = state.recorder_service.stop(&app, discard);
    // Exclusion stays on — see the note in `stop_scroll_capture`.
    let _ = state.toast_service.hide(&app);
    result
}

/// Audio endpoints available to the recorder, for the settings UI.
/// `system` lists render endpoints (captured in loopback); otherwise
/// capture endpoints (microphones).
///
/// Returns an empty list rather than erroring when the machine has none
/// of that kind — a laptop with no microphone is a configuration, not a
/// fault.
#[tauri::command]
pub fn list_audio_devices(system: bool) -> AppResult<Vec<AudioDeviceInfo>> {
    #[cfg(target_os = "windows")]
    {
        use clippity_platform::windows::audio::{list_devices, Direction};
        use clippity_platform::windows::media_foundation::ComThread;

        // Enumeration is COM; the command thread is not guaranteed to be
        // on an apartment, so join one for the duration of the call.
        let _com = ComThread::init()?;
        let direction = if system {
            Direction::SystemLoopback
        } else {
            Direction::Microphone
        };
        Ok(list_devices(direction)?
            .into_iter()
            .map(|d| AudioDeviceInfo {
                id: d.id,
                name: d.name,
                is_default: d.is_default,
            })
            .collect())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = system;
        Ok(Vec::new())
    }
}

/// Cameras available as a recording source, for the sources UI
/// (ADR 0033).
///
/// Empty rather than an error on a machine with no camera, for the same
/// reason `list_audio_devices` is: it is a configuration, not a fault,
/// and the UI renders it as "no cameras found".
#[tauri::command]
pub fn list_webcams() -> AppResult<Vec<WebcamDeviceInfo>> {
    #[cfg(target_os = "windows")]
    {
        use clippity_platform::windows::media_foundation::ComThread;
        use clippity_platform::windows::webcam::list_devices;

        // Enumeration is COM; the command thread is not guaranteed to be
        // on an apartment, so join one for the duration of the call.
        let _com = ComThread::init()?;
        Ok(list_devices()?
            .into_iter()
            .map(|d| WebcamDeviceInfo {
                id: d.id,
                name: d.name,
            })
            .collect())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

/// Wire shape for a camera. Declared beside [`AudioDeviceInfo`] and for
/// the same reason: it describes a platform capability rather than a
/// domain concept.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebcamDeviceInfo {
    pub id: String,
    pub name: String,
}

/// Wire shape for an audio endpoint. Declared here rather than in
/// `domain` because it describes a platform capability rather than a
/// domain concept — there is no pure rule about it to test.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Id of the desktop snapshot the overlay should be showing, so its
/// backdrop, loupe and small-selection preview can load the pixels
/// without re-grabbing the screen. `None` if none is currently servable
/// (overlay not open, encode still running, or the grab failed).
///
/// Deliberately an id and not the image. The overlay builds a
/// `clippity-snapshot` URL from it and lets the webview fetch the bytes,
/// which keeps this IPC a few bytes wide regardless of desktop size —
/// the previous shape returned a base64 data URI, which at 1920×1200 was
/// an 11 MiB JSON string to serialize, transfer and decode before the
/// magnifier could show anything.
#[tauri::command]
pub fn get_desktop_snapshot_id(state: tauri::State<'_, AppState>) -> AppResult<Option<u64>> {
    Ok(state.overlay_service.snapshot_id())
}

/// The last rectangular selection, resolved against the CURRENT virtual
/// desktop, for the overlay's "restore last region" action. `None` when
/// nothing has been captured yet, or when the stored rect no longer fits
/// on screen. Non-strict: a region from a differently-sized desktop is
/// clamped into range rather than rejected, because the overlay shows it
/// to the user as an editable selection before anything is captured.
#[tauri::command]
pub fn last_region(state: tauri::State<'_, AppState>) -> AppResult<Option<Region>> {
    Ok(state.overlay_service.last_region(false))
}

/// One-shot repeat of the last rectangular selection — no overlay, no
/// drag. Grabs a fresh snapshot, crops the remembered rect, saves,
/// optionally copies to the clipboard, emits
/// `clippity://capture/finished`.
///
/// Errors when nothing is remembered, or when the virtual desktop has
/// changed size since (strict resolution — nothing is shown for the user
/// to sanity-check before the shutter fires).
#[tauri::command]
pub fn recapture_last_region(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    toggles: OverlayToggles,
) -> AppResult<OverlayResult> {
    state.overlay_service.recapture_last(&app, toggles)
}

/// Serve the cached list of capturable top-level windows for the
/// overlay's Window mode (front-to-back Z-order, canvas-local coords).
/// Empty unless the overlay is currently open in Window mode. The
/// frontend hit-tests these on pointer-move to highlight the window
/// under the cursor, then hands the chosen rect straight back to
/// `finish_region_capture` on click — a window capture is just a
/// pre-snapped region.
#[tauri::command]
pub fn overlay_windows(state: tauri::State<'_, AppState>) -> AppResult<Vec<OverlayWindow>> {
    Ok(state.overlay_service.windows())
}

/// Show a toast with `payload`. MVP only routes the `error` variant;
/// reserved variants reject with `Unsupported` until their owning
/// port lands. Backend repositions the toast against the cursor's
/// monitor's work area before revealing, then emits
/// `clippity://toast/show` with the payload + per-kind durationMs.
#[tauri::command]
pub fn show_toast(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    payload: ToastPayload,
) -> AppResult<()> {
    state.toast_service.show(&app, payload)
}

/// Hide the toast window. Frontend's `useToastContent` calls this
/// after its 220ms exit animation completes; backend also emits
/// `clippity://toast/hide` so any future passive listeners can sync.
#[tauri::command]
pub fn hide_toast(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.toast_service.hide(&app)
}

/// Resize the toast to fit measured content (logical pixels) and
/// re-anchor to the configured corner. Backend clamps to a sane
/// envelope; the frontend's `useToastResize` calls this only when
/// the measured height actually changed (idempotent skip).
#[tauri::command]
pub fn resize_toast(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    width: f64,
    height: f64,
) -> AppResult<()> {
    state.toast_service.resize(&app, width, height)
}

/// Bring the capture window forward and hide every other primary
/// window. Used by the toast's Focus button, the dashboard's Capture
/// nav item, and anywhere else "switch to the capture window" is
/// the intent. Enforces the single-primary-window invariant.
#[tauri::command]
pub fn show_capture_window(app: tauri::AppHandle) -> AppResult<()> {
    window_service::focus_primary_window(&app, "capture");
    Ok(())
}

/// Library — enumerate the captures dir (and `.trash` if requested)
/// into a newest-first list of `CaptureMeta`. Missing dir is silent
/// (returns empty vec).
#[tauri::command]
pub fn library_list(
    state: tauri::State<'_, AppState>,
    include_trashed: bool,
) -> AppResult<Vec<CaptureMeta>> {
    state.library_service.list(include_trashed)
}

/// How a [`LibraryQueryArgs`] orders its page — the wire twin of the
/// frontend `LibrarySort` and the services `QuerySort`.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LibrarySortArg {
    #[default]
    Newest,
    Oldest,
    Name,
    Largest,
}

impl From<LibrarySortArg> for clippity_services::library_index::QuerySort {
    fn from(s: LibrarySortArg) -> Self {
        use clippity_services::library_index::QuerySort;
        match s {
            LibrarySortArg::Newest => QuerySort::Newest,
            LibrarySortArg::Oldest => QuerySort::Oldest,
            LibrarySortArg::Name => QuerySort::Name,
            LibrarySortArg::Largest => QuerySort::Largest,
        }
    }
}

/// The grid's filters, search, sort and page, as they arrive from the
/// frontend. Every field defaults, so `{}` is "the first page of
/// everything, newest first".
/// Which half of the library a page reads — the wire twin of the services
/// `TrashFilter`. `only` is what the trash view asks for; `include` is the
/// superset `library_list` returns.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashFilterArg {
    #[default]
    Exclude,
    Include,
    Only,
}

impl From<TrashFilterArg> for clippity_services::library_index::TrashFilter {
    fn from(t: TrashFilterArg) -> Self {
        use clippity_services::library_index::TrashFilter;
        match t {
            TrashFilterArg::Exclude => TrashFilter::Exclude,
            TrashFilterArg::Include => TrashFilter::Include,
            TrashFilterArg::Only => TrashFilter::Only,
        }
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryQueryArgs {
    pub trash: TrashFilterArg,
    pub kind: Option<CaptureKind>,
    pub favorites_only: bool,
    pub tag: Option<String>,
    pub search: Option<String>,
    pub sort: LibrarySortArg,
    pub limit: Option<u32>,
    pub offset: u32,
}

/// One page of the library plus the total rows the filters match — the
/// shape a virtualized grid needs to render a window and size its
/// scrollbar without holding every row.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturePage {
    pub items: Vec<CaptureMeta>,
    pub total: u64,
}

/// Library — one filtered/searched/sorted **page** of the listing, with
/// the narrowing pushed into SQL so a large library materializes only the
/// rows a page shows (performance roadmap P5). Smart collections and
/// collection membership are not expressible as a single query and stay
/// with the caller.
#[tauri::command]
pub fn library_query(
    state: tauri::State<'_, AppState>,
    query: LibraryQueryArgs,
) -> AppResult<CapturePage> {
    let q = clippity_services::library_index::LibraryQuery {
        trash: query.trash.into(),
        kind: query.kind,
        favorites_only: query.favorites_only,
        tag: query.tag,
        search: query.search,
        sort: query.sort.into(),
        limit: query.limit,
        offset: query.offset,
    };
    let page = state.library_service.query(&q)?;
    Ok(CapturePage {
        items: page.items,
        total: page.total,
    })
}

/// The thresholds the rail's derived sets are cut at, as they arrive from
/// the frontend. They come from the client because they are anchored to
/// the user's clock and local midnight — see `library_index::FacetsQuery`.
#[derive(Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryFacetsArgs {
    pub this_week_since_ms: i64,
    pub last_30_days_since_ms: i64,
    pub large_min_bytes: i64,
}

/// One tag and how many live captures carry it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u64,
}

/// Sizes of the rail's derived sets.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartCounts {
    pub this_week: u64,
    pub last_30_days: u64,
    pub large: u64,
    pub untagged: u64,
}

/// Whole-library counts for the destination rail — the aggregate half of
/// a paged library. Kinds arrive as an object keyed by the kind's wire
/// spelling, so a caller reads `kinds.image` rather than searching a list.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFacets {
    pub total: u64,
    pub kinds: std::collections::HashMap<CaptureKind, u64>,
    pub favorites: u64,
    pub trashed: u64,
    pub tags: Vec<TagCount>,
    pub smart: SmartCounts,
}

/// Library — every count the destination rail shows, over the whole
/// library rather than the page the grid holds (performance roadmap P5).
///
/// Separate from `library_query` on purpose: a page cannot answer "how
/// big is every other scope", and making the rail derive its counts from
/// a listing is the full-library load that pushing the grid into SQL was
/// meant to remove.
#[tauri::command]
pub fn library_facets(
    state: tauri::State<'_, AppState>,
    query: LibraryFacetsArgs,
) -> AppResult<LibraryFacets> {
    let q = clippity_services::library_index::FacetsQuery {
        this_week_since_ms: query.this_week_since_ms,
        last_30_days_since_ms: query.last_30_days_since_ms,
        large_min_bytes: query.large_min_bytes,
    };
    let f = state.library_service.facets(&q)?;
    Ok(LibraryFacets {
        total: f.total,
        kinds: f.kinds,
        favorites: f.favorites,
        trashed: f.trashed,
        tags: f
            .tags
            .into_iter()
            .map(|t| TagCount {
                tag: t.tag,
                count: t.count,
            })
            .collect(),
        smart: SmartCounts {
            this_week: f.smart.this_week,
            last_30_days: f.smart.last_30_days,
            large: f.smart.large,
            untagged: f.smart.untagged,
        },
    })
}

/// Library — decode + downscale the file at `id`, return a
/// base64 PNG data URI. Frontend `useThumbnail` caches the result;
/// the backend re-decodes on every call.
#[tauri::command]
pub fn library_thumbnail(
    state: tauri::State<'_, AppState>,
    id: String,
    max_width: u32,
) -> AppResult<String> {
    state.library_service.thumbnail(&id, max_width)
}

/// Library — soft-delete the file at `id` (move to `<captures>/.trash/`).
/// Returns the new path (= the new id). Emits `library/updated`.
#[tauri::command]
pub fn library_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    let new_id = state.library_service.delete(&id)?;
    events::emit(&app, events::names::LIBRARY_UPDATED, ())?;
    Ok(new_id)
}

/// Library — restore a trashed capture back to `<captures>/`.
/// Returns the new path. Emits `library/updated`.
#[tauri::command]
pub fn library_restore(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<String> {
    let new_id = state.library_service.restore(&id)?;
    events::emit(&app, events::names::LIBRARY_UPDATED, ())?;
    Ok(new_id)
}

/// Library — permanently delete the file at `id`. Emits
/// `library/updated`.
#[tauri::command]
pub fn library_purge(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    state.library_service.purge(&id)?;
    events::emit(&app, events::names::LIBRARY_UPDATED, ())?;
    Ok(())
}

/// Library — recursive byte-count of the captures dir + a fixed
/// 10 GiB display cap. Used by a future storage-progress footer.
#[tauri::command]
pub fn library_storage(state: tauri::State<'_, AppState>) -> AppResult<StorageInfo> {
    state.library_service.storage()
}

/// Library — throw the listing cache away and rebuild it from disk,
/// returning the row count. Emits `library/updated`.
///
/// Not needed in normal operation: every listing reconciles the index
/// against the filesystem first, so it cannot drift. This is the escape
/// hatch that makes "the index is rebuildable at any time" a property
/// you can exercise rather than a claim — and the repair for the one
/// case reconciliation can't see, a capture rewritten within the same
/// millisecond and to the same byte count as the row it replaced.
#[tauri::command]
pub fn library_reindex(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> AppResult<u64> {
    let rows = state.library_service.reindex()?;
    events::emit(&app, events::names::LIBRARY_UPDATED, ())?;
    Ok(rows)
}

/// Library — star or unstar every id. Emits `library/updated`.
///
/// Every label command takes a **list**, so one capture and a
/// forty-capture selection are the same call: bulk operations cost the
/// UI no fan-out and the backend no second code path (ADR 0029). The
/// return value is how many entries actually changed — an edit that asks
/// for what is already true writes nothing.
#[tauri::command]
pub fn library_set_favorite(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    favorite: bool,
) -> AppResult<u64> {
    let changed = state
        .library_service
        .update_labels(&ids, LabelEdit::Favorite(favorite))?;
    emit_library_updated(&app, changed)?;
    Ok(changed)
}

/// Library — merge `tags` into every id's existing tags.
#[tauri::command]
pub fn library_add_tags(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    tags: Vec<String>,
) -> AppResult<u64> {
    let changed = state
        .library_service
        .update_labels(&ids, LabelEdit::AddTags(&tags))?;
    emit_library_updated(&app, changed)?;
    Ok(changed)
}

/// Library — drop `tags` from every id, ignoring case.
#[tauri::command]
pub fn library_remove_tags(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    tags: Vec<String>,
) -> AppResult<u64> {
    let changed = state
        .library_service
        .update_labels(&ids, LabelEdit::RemoveTags(&tags))?;
    emit_library_updated(&app, changed)?;
    Ok(changed)
}

/// Library — replace every id's tag list wholesale (the tag editor's
/// "done").
#[tauri::command]
pub fn library_set_tags(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Vec<String>,
    tags: Vec<String>,
) -> AppResult<u64> {
    let changed = state
        .library_service
        .update_labels(&ids, LabelEdit::SetTags(&tags))?;
    emit_library_updated(&app, changed)?;
    Ok(changed)
}

/// Emit `library/updated` only when an edit actually moved something.
/// A no-op edit that still fired the event would make every listener
/// re-fetch the library for nothing.
fn emit_library_updated(app: &tauri::AppHandle, changed: u64) -> AppResult<()> {
    if changed == 0 {
        return Ok(());
    }
    events::emit(app, events::names::LIBRARY_UPDATED, ())
}

/// Collections — every collection, in creation order.
#[tauri::command]
pub fn collections_list(state: tauri::State<'_, AppState>) -> AppResult<Vec<Collection>> {
    Ok(state.collections_service.list())
}

/// Collections — create an empty collection. A blank name is refused.
#[tauri::command]
pub fn collections_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
) -> AppResult<Collection> {
    let created = state.collections_service.create(&name)?;
    events::emit(&app, events::names::COLLECTIONS_UPDATED, ())?;
    Ok(created)
}

/// Collections — rename. The id is the identity, so this is safe for
/// membership and duplicate names are allowed.
#[tauri::command]
pub fn collections_rename(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    name: String,
) -> AppResult<Collection> {
    let renamed = state.collections_service.rename(&id, &name)?;
    events::emit(&app, events::names::COLLECTIONS_UPDATED, ())?;
    Ok(renamed)
}

/// Collections — delete the collection. The captures in it are
/// untouched: a collection arranges files, it doesn't hold them.
#[tauri::command]
pub fn collections_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    state.collections_service.remove(&id)?;
    events::emit(&app, events::names::COLLECTIONS_UPDATED, ())
}

/// Collections — append captures, skipping ones already in it.
#[tauri::command]
pub fn collections_add_members(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    capture_ids: Vec<String>,
) -> AppResult<Collection> {
    let updated = state.collections_service.add_members(&id, &capture_ids)?;
    events::emit(&app, events::names::COLLECTIONS_UPDATED, ())?;
    Ok(updated)
}

/// Collections — remove captures from the collection.
#[tauri::command]
pub fn collections_remove_members(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    capture_ids: Vec<String>,
) -> AppResult<Collection> {
    let updated = state
        .collections_service
        .remove_members(&id, &capture_ids)?;
    events::emit(&app, events::names::COLLECTIONS_UPDATED, ())?;
    Ok(updated)
}

/// Collections — rearrange. Ids the order forgets keep their relative
/// place at the end, so a reorder computed before another window added a
/// capture can't delete it.
#[tauri::command]
pub fn collections_set_order(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
    capture_ids: Vec<String>,
) -> AppResult<Collection> {
    let updated = state.collections_service.set_order(&id, &capture_ids)?;
    events::emit(&app, events::names::COLLECTIONS_UPDATED, ())?;
    Ok(updated)
}

/// Editor — load the file at `id` as a base64 image data URI (the MIME
/// follows the file's extension) plus the decoded width/height. Rejects
/// ids that escape the captures dir (defense-in-depth via
/// `library::validate_id`).
#[tauri::command]
pub fn editor_load(state: tauri::State<'_, AppState>, id: String) -> AppResult<EditorImage> {
    state.editor_service.load(&id)
}

/// Editor — persist a flattened image (annotations + effects already
/// baked into pixels by the frontend Canvas2D flatten) as a new
/// capture file in the captures dir. The data URI's format — PNG, JPEG
/// or WebP — picks the on-disk extension. Emits `library/updated` so the
/// library refreshes if it's currently mounted. Returns the new
/// absolute path.
#[tauri::command]
pub fn editor_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    data_uri: String,
) -> AppResult<String> {
    let path = state.editor_service.save(&data_uri)?;
    events::emit(&app, events::names::LIBRARY_UPDATED, ())?;
    Ok(path)
}

/// Editor — persist the editable scene (a JSON document, frontend-owned
/// format) as a sidecar beside capture `id`, under the hidden `.scenes`
/// dir. Non-destructive (the capture file is untouched); does not emit
/// `library/updated` because the library listing is unchanged. Returns
/// the sidecar's absolute path.
#[tauri::command]
pub fn editor_save_scene(
    state: tauri::State<'_, AppState>,
    id: String,
    scene: String,
) -> AppResult<String> {
    state.editor_service.save_scene(&id, &scene)
}

/// Studio — describe the recording at `id` and mint the token its bytes
/// are fetchable under.
///
/// Note what this deliberately does *not* return: the media itself. A
/// recording is far too large to cross the IPC bridge, and a `<video>`
/// element needs to seek into it rather than receive it — so the bytes
/// travel over the `clippity-media` URI scheme instead, which resolves
/// the returned token back to this file. See `media_scheme`.
///
/// Rejects ids outside the captures dir (`library::validate_id`) and
/// anything that isn't a video.
#[tauri::command]
pub fn media_probe(state: tauri::State<'_, AppState>, id: String) -> AppResult<MediaInfo> {
    state.media_service.probe(&id)
}

/// Studio — encode the requested range of a recording as a new capture.
///
/// Runs on a blocking thread, not the async runtime: the encode is a
/// long, synchronous COM call chain (Media Foundation is `!Send` and
/// has no async surface), and parking a runtime worker on it for the
/// length of an export would stall every other command the app makes.
///
/// The result comes back as the return value rather than as an event —
/// unlike a recording, which can end with nobody having called
/// anything, an export always has a caller waiting. Progress travels as
/// `media/trim-progress` because there is no other way to report it
/// mid-call.
#[tauri::command]
pub async fn media_trim(app: tauri::AppHandle, request: TrimRequest) -> AppResult<TrimResult> {
    use tauri::Manager;

    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let result = state.media_service.trim(&request, &|progress| {
            // Best-effort: losing a progress tick must never fail an
            // export that is otherwise succeeding.
            let _ = events::emit(&handle, events::names::MEDIA_TRIM_PROGRESS, progress);
        })?;
        // A trimmed clip is a new capture; the library refreshes on it.
        events::emit(&handle, events::names::LIBRARY_UPDATED, ())?;
        Ok(result)
    })
    .await
    .map_err(|e| AppError::Media(format!("the export did not finish: {e}")))?
}

/// Studio — stage one rendered annotation overlay for an export.
///
/// The webview draws its annotations to a canvas — the same code that
/// draws them on screen, which is what stops the preview and the export
/// from ever disagreeing — and hands the PNG here. `media_trim` then
/// names the returned paths and the encoder composites them.
///
/// Staged as files rather than carried inline in the trim request for
/// the reason ADR 0032 gave for the clip itself: IPC serialises a
/// payload whole, and a handful of full-resolution bitmaps is megabytes.
/// One call per interval between annotation boundaries — not per frame.
///
/// The service picks the path and verifies the bytes are a PNG; the
/// caller supplies only base64. Staged files are deleted when the export
/// that used them finishes, however it finishes.
#[tauri::command]
pub fn media_stage_overlay(
    state: tauri::State<'_, AppState>,
    png_base64: String,
) -> AppResult<String> {
    state.media_service.stage_overlay(&png_base64)
}

/// Studio — ask the running export to stop.
///
/// Cooperative and idempotent: a no-op when nothing is running, and the
/// encode unwinds at a frame boundary, deleting its working file rather
/// than leaving a half-written container in the captures directory.
#[tauri::command]
pub fn media_cancel_trim(state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.media_service.cancel_trim();
    Ok(())
}

/// Dashboard — stash a "switch to this view" request, hide other
/// primary windows, then show + focus the main window. Emits
/// `clippity://dashboard/view` for the already-shown case. The
/// dashboard reads the stash via `consume_pending_dashboard_view`
/// on its first mount (race-free for the cold-show case).
#[tauri::command]
pub fn request_dashboard_view(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    view: DashboardView,
    capture_id: Option<String>,
) -> AppResult<()> {
    {
        let mut slot = state
            .pending_dashboard_view
            .lock()
            .map_err(|_| AppError::Library("pending_dashboard_view poisoned".into()))?;
        *slot = Some(DashboardRequest {
            view,
            capture_id: capture_id.clone(),
        });
    }
    window_service::focus_primary_window(&app, "main");
    events::emit(
        &app,
        events::names::DASHBOARD_VIEW,
        DashboardRequest { view, capture_id },
    )?;
    Ok(())
}

/// Dashboard — drain and return the pending view request, if any.
/// Called by the dashboard on mount. Idempotent: calling twice
/// returns `None` the second time.
#[tauri::command]
pub fn consume_pending_dashboard_view(
    state: tauri::State<'_, AppState>,
) -> AppResult<Option<DashboardRequest>> {
    let mut slot = state
        .pending_dashboard_view
        .lock()
        .map_err(|_| AppError::Library("pending_dashboard_view poisoned".into()))?;
    Ok(slot.take())
}

/// Settings — snapshot the current persisted settings. The dashboard's
/// `useSettings` hook calls this once on mount; subsequent changes
/// arrive via `clippity://settings/changed` events.
#[tauri::command]
pub fn settings_get(state: tauri::State<'_, AppState>) -> AppResult<Settings> {
    Ok(state.settings_service.snapshot())
}

/// Countdown — position the strip on the cursor monitor's work-area
/// bottom edge, show, and emit `clippity://countdown/start` with the
/// starting seconds. The frontend's `useCountdown` listener owns the
/// per-second tick + Esc handling; this command only sets up the
/// window. Rejects 0 or >MAX_COUNTDOWN_SECONDS with `AppError::Countdown`.
#[tauri::command]
pub fn start_countdown(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: CountdownRequest,
) -> AppResult<()> {
    state.countdown_service.start(&app, request)
}

/// Countdown — hide the strip and abort the in-flight tick. Used by
/// the frontend's Esc handler. Idempotent.
#[tauri::command]
pub fn cancel_countdown(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.countdown_service.cancel(&app)
}

/// Countdown — hide the strip after a successful tick-to-zero. Same
/// effect as `cancel_countdown` from the service's perspective; kept
/// as a distinct command so the caller can branch on intent
/// (proceed-with-capture vs. user-aborted).
#[tauri::command]
pub fn finish_countdown(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.countdown_service.finish(&app)
}

/// Settings — return the default captures directory the backend would
/// use when `general.capturesDir` is empty (i.e. `AppPaths.captures`).
/// Used by the onboarding wizard's Storage step to show a real path as
/// the "Current location" hint rather than the bare word "default".
#[tauri::command]
pub fn settings_default_captures_dir(state: tauri::State<'_, AppState>) -> AppResult<String> {
    Ok(state
        .settings_service
        .fallback_captures_dir()
        .to_string_lossy()
        .into_owned())
}

/// Settings — merge `patch` into persisted settings, validate, write
/// to disk, emit `clippity://settings/changed` with the full new
/// state. Each `SettingsPatch` section (`general`/`appearance`/
/// `notifications`) is optional — present sections replace the whole
/// sub-struct, absent sections are preserved.
#[tauri::command]
pub fn settings_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    patch: SettingsPatch,
) -> AppResult<Settings> {
    // Re-register the OS-global capture hotkey only when the patch
    // actually carried the `shortcuts` section — most updates (accent,
    // toast durations, …) don't, and re-registering on every save would
    // needlessly churn the accelerator. The command boundary is the
    // single choke point where every settings write meets the `AppHandle`
    // the plugin needs.
    let touches_shortcuts = patch.shortcuts.is_some();
    let next = state.settings_service.update(&app, patch)?;
    // …and only when the capture integration was actually installed. Without
    // this check a settings write would re-register the accelerator that
    // startup deliberately skipped, quietly undoing the user's install-time
    // choice on the first unrelated settings save.
    if touches_shortcuts && state.provisioning_service.capabilities().global_hotkeys {
        state.global_shortcut_service.apply(&app, &next.shortcuts);
    }
    Ok(next)
}

/// What this installation may offer, per the installer's recorded choices.
///
/// The frontend reads this once on mount and hides the features it reports
/// as unavailable, so a declined component is absent from the UI rather than
/// present-and-failing. Every gated command refuses independently — this is
/// for presentation, never the enforcement point.
#[tauri::command]
pub fn provisioning_get(state: tauri::State<'_, AppState>) -> InstallationProfile {
    InstallationProfile {
        capabilities: state.provisioning_service.capabilities(),
        source: state.provisioning_service.source().as_str(),
    }
}

/// The capability set plus where it came from, so the UI can distinguish
/// "the user declined this" from "we have no installer answers at all".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationProfile {
    pub capabilities: Capabilities,
    /// One of `installer` / `portable` / `absent` / `unusable`.
    pub source: &'static str,
}

/// Tray — hide the flyout panel. Called by the frontend after an action
/// fires or when the user presses Esc inside the panel. Idempotent (a
/// hide on an already-hidden panel is a silent no-op).
#[tauri::command]
pub fn hide_tray_panel(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> AppResult<()> {
    state.tray_service.hide_panel(&app)
}

/// Quit the whole application. The tray panel's Quit affordance and the
/// native tray menu's "Quit Clippity" both end the process here — with
/// minimize-to-tray on window close (see `lib.rs`), this is the
/// deliberate exit path.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) -> AppResult<()> {
    app.exit(0);
    Ok(())
}

/// Restart the whole application. The Performance settings panel's
/// "Restart now" affordance calls this after the user flips GPU
/// acceleration — the WebView2 GPU browser arg is fixed at
/// webview-environment creation, so the new preference only takes hold
/// on a fresh process. `restart()` diverges (never returns), which
/// coerces to the `AppResult<()>` the invoke handler expects.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) -> AppResult<()> {
    app.restart()
}

/// Presets — list every saved capture preset (insertion order).
#[tauri::command]
pub fn presets_list(state: tauri::State<'_, AppState>) -> AppResult<Vec<CapturePreset>> {
    Ok(state.presets_service.list())
}

/// Presets — create a preset from `input` (backend mints the id),
/// persist, and emit `clippity://presets/changed` with the full list.
#[tauri::command]
pub fn presets_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    input: PresetInput,
) -> AppResult<CapturePreset> {
    state.presets_service.create(&app, input)
}

/// Presets — replace the preset with the same id. Errors if none match.
#[tauri::command]
pub fn presets_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    preset: CapturePreset,
) -> AppResult<CapturePreset> {
    state.presets_service.update(&app, preset)
}

/// Presets — delete the preset with `id`. Idempotent.
#[tauri::command]
pub fn presets_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    state.presets_service.delete(&app, &id)
}

/// Models — every registry model with its live status (installed /
/// downloading / error / not installed). The Models settings page
/// fetches this on mount; subsequent transitions arrive via
/// `clippity://models/changed`.
#[tauri::command]
pub fn models_list(state: tauri::State<'_, AppState>) -> AppResult<Vec<ModelInfo>> {
    Ok(state.model_service.list())
}

/// Models — start downloading `id` on a worker thread. Idempotent
/// (no-op when already installed or already downloading). Progress
/// streams via `clippity://models/progress`; the final status lands
/// with `clippity://models/changed`.
#[tauri::command]
pub fn models_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    state.model_service.download(&app, &id)
}

/// Models — flag an in-flight download for cancellation. The worker
/// cleans up its partial file and emits `models/changed`. No-op when
/// nothing is downloading.
#[tauri::command]
pub fn models_cancel_download(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    state.model_service.cancel(&id)
}

/// Models — delete an installed model from disk (cancelling any
/// in-flight download first) and drop the cached inference session so
/// a stale in-memory model can't outlive its artifact.
#[tauri::command]
pub fn models_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    state.vision_service.invalidate(&id);
    state.model_service.remove(&app, &id)
}

/// Models — best-effort live check of every GitHub-hosted model against
/// its latest published release. The Models settings page fires this on
/// open (alongside `models_list`) to tell the user whether what's on disk
/// is the newest published version. Returns one `ReleaseCheck` per model
/// reachable; models whose check fails (offline, rate-limited) are simply
/// absent from the list. Cached briefly server-side to respect GitHub's
/// unauthenticated rate limit.
#[tauri::command]
pub fn models_check_updates(state: tauri::State<'_, AppState>) -> AppResult<Vec<ReleaseCheck>> {
    Ok(state.model_service.check_updates())
}

/// Models — self-update `id` to the latest published GitHub release,
/// fetching that release's live assets (not the pinned registry bytes).
/// Idempotent like `models_download`: a no-op when a fetch is already in
/// flight. Progress + final status ride the same `models/progress` +
/// `models/changed` events.
#[tauri::command]
pub fn models_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    state.model_service.update_latest(&app, &id)
}

/// Object capture mode — readiness check + auto-download policy for
/// the configured detector. The capture window calls this before
/// opening the overlay in Object mode: `ready` → open; `downloading` →
/// surface a "fetching the model" toast and bail; `missing` → point the
/// user at Settings → Models.
#[tauri::command]
pub fn ensure_object_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<ObjectModelReadiness> {
    let prefs = state.settings_service.snapshot().models;
    state.model_service.ensure_object_model(&app, &prefs)
}

/// Object capture mode — run the configured detector over the cached
/// overlay snapshot and return canvas-space boxes (physical px,
/// virtual-desktop origin — the same space `finish_region_capture`
/// crops in). Requires an open overlay session (the snapshot) and an
/// installed model; errors carry the `vision` code so the overlay can
/// surface them inline.
#[tauri::command]
pub fn detect_objects(state: tauri::State<'_, AppState>) -> AppResult<Vec<DetectedObject>> {
    let canvas = state
        .overlay_service
        .detection_canvas()
        .ok_or_else(|| AppError::Vision("no desktop snapshot to analyze".into()))?;
    let prefs = state.settings_service.snapshot().models;
    let spec = clippity_vision::model_service::resolve_object_spec(&prefs);
    if !state.model_service.is_installed(spec) {
        return Err(AppError::Vision(format!(
            "model not installed: {}",
            spec.label
        )));
    }
    let confidence = clippity_domain::settings::clamp_confidence(prefs.confidence) as f32 / 100.0;
    // Typed models also load their crop classifier; detection-only
    // models pass no typer path.
    let typer_path = spec.typer.map(|_| state.model_service.typer_path(spec.id));
    state.vision_service.detect(
        &canvas,
        spec,
        &state.model_service.model_path(spec.id),
        typer_path.as_deref(),
        confidence,
    )
}

// ---------------------------------------------------------------------
// Developer & diagnostics — Settings → Advanced.
//
// Every handler here is read-only except three: `developer_clear_cache`,
// `developer_clear_logs`, and `developer_restart_safe_mode`. Those three
// take a fixed enum or no argument at all, so the surface can never be
// asked to delete an arbitrary path — see `domain::developer`.
// ---------------------------------------------------------------------

/// Developer — everything the system-information card shows, and the
/// first file in an exported bundle.
///
/// The WebView2 version is asked for here rather than in the service
/// because it is Tauri's to answer; the installed-model list likewise
/// comes from the model service.
#[tauri::command]
pub fn developer_system_info(state: tauri::State<'_, AppState>) -> AppResult<SystemInfo> {
    Ok(state
        .diagnostics_service
        .system_info(tauri::webview_version().ok(), installed_model_ids(&state)))
}

/// Registry ids of every model currently on disk, with the version the
/// bytes are from when it is known.
///
/// `UpdateAvailable` counts as installed — a complete older release is
/// on disk, and "which model files does this machine have?" is the
/// question a diagnostics bundle is answering.
fn installed_model_ids(state: &tauri::State<'_, AppState>) -> Vec<String> {
    state
        .model_service
        .list()
        .into_iter()
        .filter(|m| {
            matches!(
                m.phase,
                ModelPhase::Installed | ModelPhase::UpdateAvailable { .. }
            )
        })
        .map(|m| match m.installed_version {
            Some(version) => format!("{} ({version})", m.id),
            None => m.id,
        })
        .collect()
}

/// Developer — live runtime state: windows, capture shielding, the
/// global hotkey's real registration, the index and cache sizes.
///
/// Answers the class of complaint the app otherwise cannot: "the hotkey
/// stopped working", "there is an invisible window", "my screenshots
/// have Clippity in them".
#[tauri::command]
pub fn developer_runtime_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<RuntimeStatus> {
    use tauri::Manager;

    let mut windows: Vec<WindowDiagnostics> = app
        .webview_windows()
        .iter()
        .map(|(label, window)| {
            let position = window.outer_position().ok();
            let size = window.outer_size().ok();
            WindowDiagnostics {
                label: label.clone(),
                visible: window.is_visible().unwrap_or(false),
                focused: window.is_focused().unwrap_or(false),
                x: position.map(|p| p.x).unwrap_or(0),
                y: position.map(|p| p.y).unwrap_or(0),
                width: size.map(|s| s.width).unwrap_or(0),
                height: size.map(|s| s.height).unwrap_or(0),
            }
        })
        .collect();
    // `webview_windows` hands back a map, so the order is arbitrary —
    // sorted here so the table does not reshuffle on every refresh.
    windows.sort_by(|a, b| a.label.cmp(&b.label));

    let shortcuts = state.settings_service.snapshot().shortcuts;
    Ok(state.diagnostics_service.runtime_status(
        windows,
        state.overlay_service.capture_shielded(),
        state.global_shortcut_service.status(&shortcuts),
        state.provisioning_service.capabilities().global_hotkeys,
    ))
}

/// Developer — open (or close) the WebView developer tools for the
/// window that asked.
///
/// Per-window rather than app-wide: each Tauri window is its own
/// webview, and the tools a user wants are the ones for the surface they
/// are looking at. In a release build this needs the `devtools` Cargo
/// feature, which the app enables — the alternative is a button that
/// works only in development, which is where it is least needed.
#[tauri::command]
pub fn developer_open_devtools(window: tauri::WebviewWindow, open: bool) -> AppResult<()> {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        if open {
            window.open_devtools();
        } else {
            window.close_devtools();
        }
        Ok(())
    }
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        let _ = (window, open);
        Err(AppError::Unsupported(
            "this build was compiled without the developer tools",
        ))
    }
}

/// Developer — record one log line forwarded from the frontend, so both
/// halves of the app share a single ordered timeline in the log file.
///
/// Deliberately not gated on developer mode: the frontend's own level
/// decides what it forwards, and dropping a frontend `error` because a
/// preference is off would lose exactly the record a bug report needs.
#[tauri::command]
pub fn developer_log(
    level: String,
    module: String,
    message: String,
    context: Option<String>,
) -> AppResult<()> {
    clippity_infra::logging::log_frontend(&level, &module, &message, context.as_deref());
    Ok(())
}

/// Developer — the last `limit` lines of the log, oldest first, parsed
/// into timestamp / level / message for the viewer.
///
/// Polled by the live viewer, so it reads a bounded window from the end
/// of the file rather than the whole file.
#[tauri::command]
pub fn developer_log_tail(limit: usize) -> AppResult<Vec<LogLine>> {
    // A viewer window, not a log reader: past a couple of thousand lines
    // the webview is the bottleneck, not the disk.
    const MAX_LINES: usize = 2_000;
    let lines = clippity_infra::logging::tail(limit.min(MAX_LINES));
    Ok(lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| developer::parse_log_line(i as u64, &line))
        .collect())
}

/// Developer — delete every rotated log file and empty the live one.
/// Returns the bytes freed.
#[tauri::command]
pub fn developer_clear_logs(state: tauri::State<'_, AppState>) -> AppResult<u64> {
    state.diagnostics_service.clear_cache(CacheTarget::Logs)
}

/// Developer — open one of the app's own folders in the file manager.
#[tauri::command]
pub fn developer_open_folder(
    state: tauri::State<'_, AppState>,
    target: FolderTarget,
) -> AppResult<String> {
    use clippity_services::settings_service::CapturesDirSource;

    let captures = state.settings_service.captures_dir();
    let opened = state.diagnostics_service.open_folder(target, &captures)?;
    Ok(opened.display().to_string())
}

/// Developer — write a diagnostics bundle and return where it landed.
///
/// The settings snapshot is serialized here (rather than read off disk
/// by the service) so the bundle records the state the app is actually
/// running with — which, on a launch where developer mode expired, is
/// not what the file says.
#[tauri::command]
pub fn developer_export_bundle(
    state: tauri::State<'_, AppState>,
    options: BundleOptions,
) -> AppResult<BundleResult> {
    let system = state
        .diagnostics_service
        .system_info(tauri::webview_version().ok(), installed_model_ids(&state));
    let system_json = serde_json::to_string_pretty(&system)?;
    let settings_json = serde_json::to_string_pretty(&state.settings_service.snapshot())?;
    state
        .diagnostics_service
        .export_bundle(&options, &system_json, &settings_json)
}

/// Developer — clear one cache, returning the bytes freed.
#[tauri::command]
pub fn developer_clear_cache(
    state: tauri::State<'_, AppState>,
    target: CacheTarget,
) -> AppResult<u64> {
    state.diagnostics_service.clear_cache(target)
}

/// Developer — statistics from the last recording session, or `None`
/// when nothing has been recorded since launch.
#[tauri::command]
pub fn developer_recorder_diagnostics(
    state: tauri::State<'_, AppState>,
) -> AppResult<Option<RecorderDiagnostics>> {
    Ok(state.recorder_service.last_diagnostics())
}

/// Developer — arm safe mode and restart.
///
/// Safe mode is a marker file consumed by the next launch (see
/// `infra::runtime`), because `restart` re-executes with this process's
/// arguments and there is nothing to attach a flag to. The restart
/// diverges, so nothing after it runs.
#[tauri::command]
pub fn developer_restart_safe_mode(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> AppResult<()> {
    state.diagnostics_service.arm_safe_mode()?;
    tracing::info!("restarting into safe mode");
    app.restart()
}

/// Facts about the running process that override what settings say.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeFlags {
    /// GPU acceleration, window effects and the global hotkey are forced
    /// off this session, whatever the settings hold.
    pub safe_mode: bool,
    /// `CLIPPITY_LOG` / `RUST_LOG` is driving the filter, so the
    /// log-level control is inert for this process.
    pub log_level_pinned: bool,
    /// Whether this build can open the WebView developer tools.
    pub devtools_available: bool,
}

/// Developer — the facts above.
///
/// Read by the settings page so it can say what is actually in force
/// rather than showing controls that quietly do nothing.
#[tauri::command]
pub fn developer_runtime_flags() -> AppResult<RuntimeFlags> {
    Ok(RuntimeFlags {
        safe_mode: clippity_infra::runtime::is_safe_mode(),
        log_level_pinned: clippity_infra::logging::env_pinned(),
        devtools_available: cfg!(any(debug_assertions, feature = "devtools")),
    })
}
