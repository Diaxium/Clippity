//! Application-wide state held by Tauri (`app.manage`).
//!
//! Each subsystem owns its own state; per-feature services live here
//! as fields so command handlers can reach them through
//! `tauri::State<AppState>`.

use std::sync::{Arc, Mutex};

use crate::tray_service::TrayService;
use clippity_domain::dashboard::DashboardRequest;
use clippity_infra::error::AppResult;
use clippity_infra::paths::AppPaths;
use clippity_services::capture_service::CaptureService;
use clippity_services::collections_service::CollectionsService;
use clippity_services::countdown_service::CountdownService;
use clippity_services::diagnostics_service::DiagnosticsService;
use clippity_services::editor_service::EditorService;
use clippity_services::global_shortcut_service::GlobalShortcutService;
use clippity_services::last_region_store::LastRegionStore;
use clippity_services::library_index;
use clippity_services::library_service::LibraryService;
use clippity_services::media_service::MediaService;
use clippity_services::overlay_service::OverlayService;
use clippity_services::presets_service::PresetsService;
use clippity_services::provisioning_service::ProvisioningService;
use clippity_services::recorder_service::RecorderService;
use clippity_services::scroll_capture_service::ScrollCaptureService;
use clippity_services::settings_service::{
    CaptureEncodingSource, CapturesDirSource, NameTemplateSource, RecordingSettingsSource,
    SettingsService, ToastSettingsSource,
};
use clippity_services::toast_service::ToastService;
use clippity_vision::model_service::ModelService;
use clippity_vision::vision_service::VisionService;

pub struct AppState {
    pub capture_service: CaptureService,
    pub overlay_service: OverlayService,
    pub toast_service: ToastService,
    pub library_service: LibraryService,
    /// The same instance `library_service` holds — collection commands
    /// read it directly, while the library's file ops carry membership
    /// across an id change through its own handle (ADR 0029).
    pub collections_service: Arc<CollectionsService>,
    pub editor_service: EditorService,
    /// Studio's side of the editor split: describes a saved recording
    /// and holds the token registry the `clippity-media` scheme resolves
    /// playback requests against.
    pub media_service: MediaService,
    pub countdown_service: CountdownService,
    /// What Settings → Advanced reads, and the redacted bundle it
    /// exports. Holds no state of its own beyond the app's paths —
    /// every answer is read fresh, because a diagnostics page that
    /// showed a cached truth would be worse than none.
    pub diagnostics_service: DiagnosticsService,
    pub tray_service: TrayService,
    /// Owns the OS-global capture hotkey registration. `apply`d at
    /// startup from the persisted `shortcuts` section and re-applied on
    /// every `settings_update`.
    pub global_shortcut_service: GlobalShortcutService,
    pub presets_service: PresetsService,
    pub recorder_service: RecorderService,
    pub scroll_capture_service: ScrollCaptureService,
    pub model_service: ModelService,
    pub vision_service: VisionService,
    pub settings_service: Arc<SettingsService>,
    /// What the installer was told to install, resolved once at startup.
    /// Read by the command layer (to refuse a feature the user declined),
    /// by the setup hook (to skip registering the global hotkey), and by
    /// the frontend (to hide those features rather than fail them).
    pub provisioning_service: Arc<ProvisioningService>,
    /// Cross-window handoff stash. The library window writes here via
    /// `request_dashboard_view`; the dashboard drains it on mount via
    /// `consume_pending_dashboard_view`. Avoids the startup race that
    /// a `listen` + first-show flow has (listener registers AFTER the
    /// emit).
    pub pending_dashboard_view: Mutex<Option<DashboardRequest>>,
}

impl AppState {
    pub fn new(paths: Arc<AppPaths>) -> AppResult<Self> {
        // Resolve what the installer was told to install before settings,
        // because a first launch seeds settings from it.
        let provisioning = Arc::new(ProvisioningService::resolve());

        // Load settings first — every subsequent service borrows a
        // trait-object view of it to resolve "the live captures dir"
        // and "the live toast settings" without restarting.
        let settings = Arc::new(SettingsService::load(paths.clone())?);
        // On the very first launch after an install, carry the wizard's
        // answers ("start at login", "automatic updates", "help improve")
        // into settings so the user finds what they chose. A no-op
        // afterwards — later launches must never overwrite what the user
        // has since changed.
        settings.seed_from_installer(&provisioning);
        let captures_dir: Arc<dyn CapturesDirSource> = settings.clone();
        let toast_settings: Arc<dyn ToastSettingsSource> = settings.clone();
        let capture_encoding: Arc<dyn CaptureEncodingSource> = settings.clone();
        let name_template: Arc<dyn NameTemplateSource> = settings.clone();
        let recording_prefs: Arc<dyn RecordingSettingsSource> = settings.clone();
        // Shared with the overlay service, which both writes it (on every
        // rectangular finalize) and reads it back (restore / recapture).
        let last_region = Arc::new(LastRegionStore::load(paths.clone())?);
        // The library's listing cache. It lives in the app data dir, not
        // among the user's captures: the captures folder holds their
        // files and each file's description, while this is app
        // machinery that a reconcile can rebuild from those at any time.
        let library_db = paths.data.join(library_index::DB_FILE_NAME);
        // Collections *are* user data — a curated arrangement of their
        // own files — so the document lives with the captures rather
        // than in the data dir beside the disposable index.
        let collections = Arc::new(CollectionsService::new(captures_dir.clone()));

        Ok(Self {
            capture_service: CaptureService::new(
                captures_dir.clone(),
                capture_encoding,
                name_template.clone(),
            ),
            overlay_service: OverlayService::new(
                captures_dir.clone(),
                name_template.clone(),
                last_region.clone(),
            ),
            toast_service: ToastService::new(toast_settings),
            library_service: LibraryService::new(
                captures_dir.clone(),
                Some(&library_db),
                collections.clone(),
            ),
            collections_service: collections,
            editor_service: EditorService::new(captures_dir.clone(), name_template.clone()),
            media_service: MediaService::new(captures_dir.clone(), name_template.clone()),
            countdown_service: CountdownService::new(),
            diagnostics_service: DiagnosticsService::new(paths.clone()),
            tray_service: TrayService::new(),
            global_shortcut_service: GlobalShortcutService::new(),
            presets_service: PresetsService::load(paths.clone())?,
            recorder_service: RecorderService::new(
                captures_dir.clone(),
                name_template.clone(),
                recording_prefs,
            ),
            scroll_capture_service: ScrollCaptureService::new(captures_dir, name_template),
            model_service: ModelService::new(paths.clone()),
            vision_service: VisionService::new(),
            settings_service: settings,
            provisioning_service: provisioning,
            pending_dashboard_view: Mutex::new(None),
        })
    }
}
