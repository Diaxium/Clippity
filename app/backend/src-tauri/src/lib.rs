//! Clippity backend — the `src-tauri` app crate.
//!
//! This crate is the top of a Cargo workspace whose layers are separate
//! crates (top-down dependency direction):
//!
//! ```text
//!   src-tauri (this crate) -- Tauri command handlers, event wiring, AppState,
//!                             the system-tray composition
//!     ↓
//!   clippity-services      -- I/O-performing services (capture, OCR, library, …)
//!   clippity-vision        -- ONNX object detection + model download
//!     ↓
//!   clippity-platform      -- OS-specific impls (Win32; AppKit later)
//!     ↓
//!   clippity-domain        -- Pure types and rules. No I/O. No Tauri.
//!     ↓
//!   clippity-infra         -- Cross-cutting: errors, logging, paths, the
//!                             outbound event channel
//! ```
//!
//! Crossing a layer is allowed only top-down. `clippity-domain` knows
//! nothing about `tauri` or `xcap`; that lets us unit-test rules without a
//! desktop session.

pub mod app;
mod tray_service;

use tauri::Manager;

/// URI scheme the overlay loads its frozen-desktop snapshot over. Must
/// match `SNAPSHOT_SCHEME` in the frontend's overlay client.
const SNAPSHOT_SCHEME: &str = "clippity-snapshot";

/// Serve the current overlay snapshot's PNG bytes to the overlay webview.
///
/// The overlay needs these pixels in three places — the frozen backdrop,
/// the magnifier, and the small-selection preview — and needs them to be
/// exactly the pixels `finalize` will crop. They used to travel as a
/// base64 data URI returned from a command, which meant an 11 MiB JSON
/// string (at 1920×1200) to serialize, ship, `atob` and then decode three
/// separate times, once per `url(…)`. Over a scheme handler the webview
/// fetches the bytes directly and caches one decode for all three.
///
/// The URL carries the snapshot's id, so a stale URL left in the
/// webview's cache from the previous session resolves to a 404 rather
/// than to this session's pixels — the id check lives in
/// `OverlayService::snapshot_png`.
fn serve_desktop_snapshot<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let app = ctx.app_handle().clone();
    snapshot_response(request.uri().path(), |id| {
        app.state::<app::state::AppState>()
            .overlay_service
            .snapshot_png(id)
            .map(|png| png.as_ref().clone())
    })
}

/// The scheme handler's whole decision, separated from the runtime so it
/// can be tested: parse the id out of the path, look the bytes up, and
/// shape the response.
///
/// Worth testing rather than eyeballing, because two of these headers are
/// load-bearing in ways that fail quietly. Without CORS the loupe's
/// `fetch` is refused while the CSS `url(…)` backdrop still paints — so
/// the overlay looks correct and the magnifier simply never samples. And
/// a wrong id must 404 rather than fall through to the current session's
/// pixels, or a cached URL from the previous overlay would silently show
/// the wrong desktop.
fn snapshot_response(
    path: &str,
    lookup: impl FnOnce(u64) -> Option<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .expect("static response builds")
    };

    // The id is the last path segment: `…/<id>`.
    let Some(png) = path
        .rsplit('/')
        .next()
        .and_then(|s| s.parse::<u64>().ok())
        .and_then(lookup)
    else {
        return not_found();
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        // The overlay page and this scheme are different origins, so the
        // `fetch` that feeds the loupe's sampling canvas is cross-origin
        // and fails without this.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // Every session mints a new id, so a URL's bytes never change.
        // Caching is what lets the backdrop, the loupe and the preview
        // share a single decode instead of forcing three.
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        .body(png)
        .unwrap_or_else(|_| not_found())
}

#[cfg(test)]
mod snapshot_scheme_tests {
    use super::snapshot_response;
    use tauri::http::{header, StatusCode};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n-pretend-";

    #[test]
    fn serves_the_bytes_for_the_current_id() {
        let res = snapshot_response("/7", |id| (id == 7).then(|| PNG.to_vec()));
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body().as_slice(), PNG);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "image/png");
    }

    #[test]
    fn allows_the_overlays_cross_origin_fetch() {
        // Without this the magnifier silently never gets pixels while the
        // backdrop still paints — see `snapshot_response`.
        let res = snapshot_response("/7", |_| Some(PNG.to_vec()));
        assert_eq!(res.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[test]
    fn a_stale_id_is_not_served_this_sessions_pixels() {
        // The previous overlay's URL, still in the webview's cache.
        let res = snapshot_response("/6", |id| (id == 7).then(|| PNG.to_vec()));
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert!(res.body().is_empty());
    }

    #[test]
    fn a_path_without_an_id_is_not_found() {
        for path in ["/", "", "/nope", "/7x", "/-1"] {
            let res = snapshot_response(path, |_| Some(PNG.to_vec()));
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "path {path:?}");
        }
    }

    #[test]
    fn caches_because_a_urls_bytes_never_change() {
        let res = snapshot_response("/7", |_| Some(PNG.to_vec()));
        let cache = res.headers()[header::CACHE_CONTROL].to_str().unwrap();
        assert!(cache.contains("immutable"), "got {cache:?}");
    }
}

/// Build and run the Tauri application.
///
/// Kept narrow so `main.rs` stays a one-liner and tests can spin the
/// builder up with mocked services.
pub fn run() {
    clippity_infra::logging::init();

    let context = tauri::generate_context!();

    // The GPU-acceleration preference must become a WebView2 browser arg
    // BEFORE any webview is built — that arg is frozen when the webview's
    // environment is created during `.run()`, so it can't be applied from
    // `setup()` (which runs after the config-declared windows already
    // exist). It reads settings.json straight from disk because no
    // service layer exists this early in boot.
    #[cfg(target_os = "windows")]
    apply_gpu_preference();

    tauri::Builder::default()
        .register_uri_scheme_protocol(SNAPSHOT_SCHEME, serve_desktop_snapshot)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // Two global accelerators can be live: Escape (registered by
            // the countdown service while its strip is up — the strip is
            // click-through + unfocused, so a global shortcut is the only
            // keyboard cancel) and the user's `shortcuts.global_capture`
            // hotkey (registered by `GlobalShortcutService`). The handler
            // routes each press to the right service.
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::{Code, Shortcut, ShortcutState};
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    // This handler fires on the MAIN thread, from inside
                    // the global-shortcut plugin's event dispatch, which
                    // holds the plugin's internal shortcut-registry lock
                    // for the whole call. Both actions below eventually
                    // touch that registry or heavy Windows window ops that
                    // must run on the UI thread, so we can't run them
                    // inline: `run_on_main_thread` called FROM the main
                    // thread runs INLINE (re-locking the non-reentrant
                    // registry → deadlock). Hop OFF the main thread first;
                    // from a worker `run_on_main_thread` genuinely defers
                    // the work to a later event-loop turn — after this
                    // dispatch returns and drops the registry lock — while
                    // still running the window ops on the UI thread.
                    let defer_on_main = |f: fn(&tauri::AppHandle)| {
                        let app_handle = app.clone();
                        std::thread::spawn(move || {
                            let for_main = app_handle.clone();
                            let _ = app_handle.run_on_main_thread(move || f(&for_main));
                        });
                    };

                    // Escape → cancel any in-flight countdown.
                    if *shortcut == Shortcut::new(None, Code::Escape) {
                        defer_on_main(|app| {
                            let state = app.state::<app::state::AppState>();
                            let _ = state.countdown_service.cancel(app);
                        });
                        return;
                    }

                    // The user's capture hotkey → open the region overlay,
                    // exactly as the Home "Screenshot" launcher does.
                    let is_capture = app
                        .state::<app::state::AppState>()
                        .global_shortcut_service
                        .is_capture_shortcut(shortcut);
                    if is_capture {
                        defer_on_main(|app| {
                            let state = app.state::<app::state::AppState>();
                            if let Err(e) = state.overlay_service.show(
                                app,
                                clippity_domain::overlay::OverlayMode::Region,
                                None,
                                None,
                            ) {
                                tracing::warn!("global capture hotkey: overlay show failed: {e}");
                            }
                        });
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Build every application window up front. These used to be
            // declared in `tauri.conf.json` (`app.windows`); they live in
            // code now so each can pin its WebView2 data directory under
            // `Clippity` instead of `%LOCALAPPDATA%\<identifier>` — see
            // `create_app_windows`. Must run before anything below looks a
            // window up by label (corner rounding, the tray icon).
            // Fold any pre-consolidation split layout (Roaming data +
            // top-level cache) into the single `%LOCALAPPDATA%\Clippity`
            // root before anything reads a path. Best-effort and idempotent
            // — see `migrate_legacy_layout`. Runs first so the webview and
            // AppPaths below see the migrated files.
            clippity_infra::paths::migrate_legacy_layout(app.handle());

            let webview_data_dir = clippity_infra::paths::webview_data_dir(app.handle())?;
            create_app_windows(app.handle(), &webview_data_dir)?;

            // Resolve paths once at startup, then hand them to the
            // capture (and future) services through AppState. Done
            // inside setup() so the AppHandle is available — Tauri's
            // path resolver depends on it.
            let paths = std::sync::Arc::new(clippity_infra::paths::AppPaths::resolve(app.handle())?);
            app.manage(app::state::AppState::new(paths.clone())?);

            // Anchor the session log with the environment it ran in:
            // version, OS, the resolved app directories, and a compact
            // settings summary. Done right after state is built so the
            // banner reflects the settings actually loaded from disk.
            {
                let settings = app
                    .state::<app::state::AppState>()
                    .settings_service
                    .snapshot();
                let captures_override = settings.general.captures_dir.trim();
                let captures_dir_is_default = captures_override.is_empty();
                let captures_dir = if captures_dir_is_default {
                    paths.captures.display().to_string()
                } else {
                    captures_override.to_string()
                };
                let theme = match settings.appearance.theme {
                    clippity_domain::settings::ThemePref::Light => "light",
                    clippity_domain::settings::ThemePref::Dark => "dark",
                    clippity_domain::settings::ThemePref::System => "system",
                };
                clippity_infra::diagnostics::log_startup(
                    &paths,
                    &clippity_infra::diagnostics::SettingsSummary {
                        captures_dir,
                        captures_dir_is_default,
                        gpu_acceleration: settings.performance.gpu_acceleration,
                        window_effects: settings.performance.window_effects,
                        theme,
                        onboarded: settings.general.onboarded,
                    },
                );
            }

            // Win11: ask DWM to natively round each frosted window and
            // paint a Mica backdrop so the transparent-decorations-false
            // chrome doesn't show a semi-transparent square frame
            // behind the CSS-rounded content. Silent no-op on Win10.
            // The frontend re-applies the backdrop with its persisted
            // theme via `apply_window_theme` on mount.
            #[cfg(target_os = "windows")]
            {
                // Exclude every Clippity window from screen capture (it
                // stays visible on the monitor, just not in any grab).
                // This is what lets the overlay snapshot the desktop
                // without first hiding our own chrome and waiting for the
                // compositor: our windows can't appear in the shot even if
                // they're still on screen when the grab fires. All windows
                // exist by now (`create_app_windows` ran above), so one
                // pass here shields them for the session.
                let shielded = clippity_platform::windows::capture_shield::shield_windows(
                    app.handle(),
                );
                app.state::<app::state::AppState>()
                    .overlay_service
                    .set_capture_shielded(shielded);
                tracing::info!(shielded, "applied capture shield to app windows");

                clippity_platform::windows::chrome::round_window_corners(app.handle());
                // Honor the persisted transparency preference at boot.
                // When window effects are on we apply Mica with `None`
                // (follow the OS theme) until the frontend pushes its
                // resolved theme via `apply_window_theme` on mount; when
                // off we skip it entirely so the window stays a flat
                // opaque surface.
                let effects = app
                    .state::<app::state::AppState>()
                    .settings_service
                    .snapshot()
                    .performance
                    .window_effects;
                if effects {
                    clippity_platform::windows::chrome::apply_backdrop(app.handle(), None);
                }
            }

            // Create the system-tray icon + native fallback menu. The
            // flyout it controls is the pre-declared `tray` window; the
            // service positions + shows it on left-click.
            app.state::<app::state::AppState>()
                .tray_service
                .build(app.handle())?;

            // Register the persisted OS-global capture hotkey (best-effort;
            // logs on failure). Re-applied on every `settings_update`.
            //
            // Skipped entirely when the installer's capture integration was
            // declined: that component *is* the OS-global hotkey, so
            // registering one would be the app quietly overriding the answer
            // the user gave the wizard. The Shortcuts panel explains the
            // absence rather than showing a dead control.
            {
                let state = app.state::<app::state::AppState>();
                if state.provisioning_service.capabilities().global_hotkeys {
                    let shortcuts = state.settings_service.snapshot().shortcuts;
                    state
                        .global_shortcut_service
                        .apply(app.handle(), &shortcuts);
                } else {
                    tracing::info!(
                        "capture integration was not installed — no OS-global \
                         capture hotkey will be registered"
                    );
                }
            }

            tracing::info!("clippity backend ready");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::commands::ping,
            app::commands::capture_fullscreen,
            app::commands::apply_window_theme,
            app::commands::apply_app_icon,
            app::commands::begin_region_capture,
            app::commands::set_overlay_mode,
            app::commands::cancel_region_capture,
            app::commands::finish_region_capture,
            app::commands::finish_fullscreen_capture,
            app::commands::share_capture,
            app::commands::finish_freehand_capture,
            app::commands::finish_brush_capture,
            app::commands::finish_multi_area_capture,
            app::commands::pick_color,
            app::commands::finish_palette_capture,
            app::commands::finish_grab_text_capture,
            app::commands::ingest_clipboard,
            app::commands::start_scroll_capture,
            app::commands::start_panoramic_capture,
            app::commands::stop_scroll_capture,
            app::commands::start_recording,
            app::commands::pause_recording,
            app::commands::resume_recording,
            app::commands::recording_status,
            app::commands::stop_recording,
            app::commands::list_audio_devices,
            app::commands::get_desktop_snapshot_id,
            app::commands::last_region,
            app::commands::recapture_last_region,
            app::commands::overlay_windows,
            app::commands::show_toast,
            app::commands::hide_toast,
            app::commands::resize_toast,
            app::commands::show_capture_window,
            app::commands::library_list,
            app::commands::library_query,
            app::commands::library_facets,
            app::commands::library_thumbnail,
            app::commands::library_delete,
            app::commands::library_restore,
            app::commands::library_purge,
            app::commands::library_storage,
            app::commands::library_reindex,
            app::commands::library_set_favorite,
            app::commands::library_add_tags,
            app::commands::library_remove_tags,
            app::commands::library_set_tags,
            app::commands::collections_list,
            app::commands::collections_create,
            app::commands::collections_rename,
            app::commands::collections_remove,
            app::commands::collections_add_members,
            app::commands::collections_remove_members,
            app::commands::collections_set_order,
            app::commands::editor_load,
            app::commands::editor_save,
            app::commands::editor_save_scene,
            app::commands::request_dashboard_view,
            app::commands::consume_pending_dashboard_view,
            app::commands::settings_get,
            app::commands::settings_update,
            app::commands::provisioning_get,
            app::commands::settings_default_captures_dir,
            app::commands::start_countdown,
            app::commands::cancel_countdown,
            app::commands::finish_countdown,
            app::commands::hide_tray_panel,
            app::commands::quit_app,
            app::commands::restart_app,
            app::commands::presets_list,
            app::commands::presets_create,
            app::commands::presets_update,
            app::commands::presets_delete,
            app::commands::models_list,
            app::commands::models_download,
            app::commands::models_cancel_download,
            app::commands::models_remove,
            app::commands::models_check_updates,
            app::commands::models_update,
            app::commands::ensure_object_model,
            app::commands::detect_objects,
        ])
        .on_window_event(|window, event| match event {
            // The tray flyout is a focus-dismissed popover: when it loses
            // focus (click outside, or another window activates) hide it.
            // Routed through the service so it can also stamp the re-open
            // guard that defeats the blur-then-click reopen flicker.
            tauri::WindowEvent::Focused(false) if window.label() == "tray" => {
                let app = window.app_handle();
                app.state::<app::state::AppState>()
                    .tray_service
                    .on_panel_blur(app);
            }
            // Close on a primary window never quits the app. The only
            // exit paths are the tray's "Quit Clippity" menu item and the
            // flyout panel's Quit affordance (both via `app.exit(0)` /
            // `quit_app`). So we prevent the default single-window destroy
            // — preserving the capture/main webview + its state for a fast
            // tray re-show — and hide to the tray instead. (Every window
            // is created at startup, so destroying just this one wouldn't
            // exit anyway.) See ADR 0003.
            tauri::WindowEvent::CloseRequested { api, .. }
                if matches!(window.label(), "capture" | "main") =>
            {
                api.prevent_close();
                let _ = window.hide();
                // If hiding this window leaves no primary window visible,
                // the app has effectively dropped to the tray. Free the
                // cached ONNX detector session (tens of MB of resident
                // model weights) so background/idle RAM stays low — it's
                // lazily rebuilt on the next object-mode capture. Cheap
                // no-op when object mode was never used.
                let app = window.app_handle();
                if clippity_services::window_service::current_visible_primary(app).is_none() {
                    let freed = app.state::<app::state::AppState>().vision_service.release();
                    if freed {
                        tracing::debug!("released vision session on tray idle");
                    }
                }
            }
            _ => {}
        })
        .run(context)
        .expect("error while running clippity");
}

/// Create every application window at startup.
///
/// These were previously declared in `tauri.conf.json`'s `app.windows`
/// array. They're built in code so each can pin its WebView2
/// `data_directory` to `webview_data_dir` (`%LOCALAPPDATA%\Clippity\webview`)
/// rather than Tauri's default `%LOCALAPPDATA%\<bundle-identifier>` —
/// that default is the one storage location `AppPaths` can't redirect,
/// because the webview data dir is derived from the identifier, not the
/// path resolver. Pinning it here keeps every Clippity file under one
/// clean folder and removes the last `com.clippity.app` directory.
///
/// All six share the frameless, transparent, shadowless chrome the
/// frontend paints itself; only `capture` is visible at boot, the rest
/// are revealed by label on demand. Creating them here preserves the
/// invariant the rest of the app depends on — every window exists from
/// startup (see the `CloseRequested` handler in `run`) — and keeps the
/// labels the `default` capability and per-label services expect.
fn create_app_windows(
    handle: &tauri::AppHandle,
    webview_data_dir: &std::path::Path,
) -> tauri::Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};

    // The startup window — the only one shown at boot.
    WebviewWindowBuilder::new(handle, "capture", WebviewUrl::App("index.html".into()))
        .title("Clippity")
        .inner_size(940.0, 640.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .center()
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .data_directory(webview_data_dir.to_path_buf())
        .build()?;

    // The dashboard — revealed on first navigation to it.
    WebviewWindowBuilder::new(handle, "main", WebviewUrl::App("index.html#/main".into()))
        .title("Clippity")
        .inner_size(1280.0, 820.0)
        .min_inner_size(1024.0, 680.0)
        .resizable(true)
        .center()
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .data_directory(webview_data_dir.to_path_buf())
        .build()?;

    // The slim "recording starts in…" strip — click-through, unfocused.
    WebviewWindowBuilder::new(
        handle,
        "countdown",
        WebviewUrl::App("index.html#/countdown".into()),
    )
    .title("Clippity Countdown")
    .inner_size(800.0, 64.0)
    .resizable(false)
    .visible(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .data_directory(webview_data_dir.to_path_buf())
    .build()?;

    // The full-screen region-capture surface.
    WebviewWindowBuilder::new(
        handle,
        "overlay",
        WebviewUrl::App("index.html#/overlay".into()),
    )
    .title("Clippity Region Capture")
    .inner_size(800.0, 600.0)
    .resizable(false)
    .visible(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .data_directory(webview_data_dir.to_path_buf())
    .build()?;

    // Border drawn around the area a recording is capturing (ADR 0031).
    // Sized and positioned per session; click-through and capture-
    // excluded, so it frames the recording for the user without ever
    // appearing in it or intercepting a click meant for the app behind.
    WebviewWindowBuilder::new(
        handle,
        "recorder-frame",
        WebviewUrl::App("index.html#/recorder-frame".into()),
    )
    .title("Clippity Recording Area")
    .inner_size(320.0, 240.0)
    .resizable(false)
    .visible(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .data_directory(webview_data_dir.to_path_buf())
    .build()?;

    // Transient capture-confirmation toasts.
    WebviewWindowBuilder::new(handle, "toast", WebviewUrl::App("index.html#/toast".into()))
        .title("Clippity Toast")
        .inner_size(380.0, 156.0)
        .resizable(false)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .data_directory(webview_data_dir.to_path_buf())
        .build()?;

    // The left-click flyout panel anchored to the tray icon.
    WebviewWindowBuilder::new(handle, "tray", WebviewUrl::App("index.html#/tray".into()))
        .title("Clippity")
        .inner_size(340.0, 464.0)
        .resizable(false)
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .data_directory(webview_data_dir.to_path_buf())
        .build()?;

    Ok(())
}

/// Translate the persisted `performance.gpuAcceleration` preference into
/// a WebView2 browser arg before any webview exists. This reads
/// settings.json directly — rather than through `SettingsService`, which
/// isn't constructed until `setup()` — because the `--disable-gpu` arg
/// must be in the environment before the webviews are built in `setup()`
/// (see `create_app_windows`), which happens during `.run()`.
///
/// The path comes from [`paths::early_settings_file`], which mirrors what
/// `AppPaths` resolves for this process — `%LOCALAPPDATA%\Clippity\data\settings.json`
/// when installed, or the `Data` folder beside the executable in portable
/// mode. Any read/parse failure is a silent no-op — GPU stays on (the
/// default), exactly like a fresh install. Disabling acceleration only
/// takes effect on the next launch, which the Performance panel
/// communicates with a "restart to apply" affordance.
///
/// [`paths::early_settings_file`]: clippity_infra::paths::early_settings_file
#[cfg(target_os = "windows")]
fn apply_gpu_preference() {
    let Some(settings_path) = clippity_infra::paths::early_settings_file() else {
        return;
    };

    let gpu_on = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|v| v.get("performance")?.get("gpuAcceleration")?.as_bool())
        .unwrap_or(true);

    if !gpu_on {
        // `--disable-gpu` drops hardware-accelerated rendering;
        // `--disable-gpu-compositing` also routes compositing through the
        // CPU so a flaky driver can't sneak GPU work back in via the
        // compositor path.
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu --disable-gpu-compositing",
        );
        tracing::info!("GPU acceleration disabled via settings");
    }
}
