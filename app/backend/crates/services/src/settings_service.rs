//! Settings orchestration — JSON persistence + in-memory snapshot
//! behind a `RwLock`. Also publishes two accessor traits
//! (`CapturesDirSource`, `ToastSettingsSource`) that the other
//! services depend on instead of `Arc<AppPaths>` / `Arc<ToastDefaults>`,
//! closing the two long-standing tech-debt rows from REBUILD.md.
//!
//! Persistence:
//! - File: `<paths.data>/settings.json`.
//! - Read at construction (`load`); ignored if absent or malformed.
//! - Written on every `update` (full-file rewrite, pretty-printed).
//!
//! Concurrency: `RwLock<Settings>` — many concurrent
//! `captures_dir()` / `toast_settings()` reads, infrequent writes
//! through `update`. The write critical section is small (snapshot,
//! patch in memory, write file, swap snapshot).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use tauri::AppHandle;

use clippity_infra::events;
use clippity_domain::recorder;
use clippity_domain::provisioning as provisioning_rules;
use clippity_domain::settings::{self, CaptureCompression, GeneralSettings, Settings, SettingsPatch};
use clippity_domain::toast::ToastDefaults;
use clippity_infra::error::{AppError, AppResult};
use clippity_infra::paths::AppPaths;

use crate::provisioning_service::ProvisioningService;

/// Live read of the active captures directory. Implemented by
/// `SettingsService` (returns the user override if non-empty, else
/// the fallback). The four file-touching services (`capture`,
/// `overlay`, `library`, `editor`) depend on this trait instead of
/// `Arc<AppPaths>` so changing the captures dir at runtime takes
/// effect on the next call without restarting.
pub trait CapturesDirSource: Send + Sync {
    fn captures_dir(&self) -> PathBuf;
}

/// Live read of the toast presentation settings (corner + per-kind
/// auto-dismiss durations). Implemented by `SettingsService`.
/// Replaces the static `Arc<ToastDefaults>` that `ToastService`
/// previously held.
pub trait ToastSettingsSource: Send + Sync {
    fn toast_settings(&self) -> ToastDefaults;
}

/// Live read of the capture PNG-encoding effort. Implemented by
/// `SettingsService`; `CaptureService` depends on this trait (not a
/// static value) so a change to `performance.capture_compression` takes
/// effect on the very next capture without a restart.
pub trait CaptureEncodingSource: Send + Sync {
    fn capture_compression(&self) -> CaptureCompression;
}

/// Live read of the capture file-name template. Implemented by
/// `SettingsService`; the four capture pipelines (`capture`, `overlay`,
/// `scroll_capture`, `editor`) depend on this trait so a change to
/// `general.name_template` names the *next* capture without a restart.
/// Returns the raw stored string — blank means "use the built-in
/// default", a decision `domain::naming::render` owns.
pub trait NameTemplateSource: Send + Sync {
    fn name_template(&self) -> String;
}

/// Live read of the recording preferences. Implemented by
/// `SettingsService`; `RecorderService` depends on this trait so a
/// change takes effect on the very next session without a restart —
/// and, more importantly, so preferences apply to **every** entry point
/// (launcher card, Record screen, overlay, a future hotkey or preset)
/// rather than only the ones that remember to send them over IPC.
pub trait RecordingSettingsSource: Send + Sync {
    fn recording(&self) -> settings::RecordingSettings;
}

pub struct SettingsService {
    file: PathBuf,
    fallback_captures: PathBuf,
    state: RwLock<Settings>,
    /// True when no `settings.json` existed at load — this process is the
    /// app's first launch on this machine, the one moment the installer's
    /// answers may seed anything (see [`SettingsService::seed_from_installer`]).
    first_launch: bool,
}

impl SettingsService {
    /// Read settings from disk (silent default-fallback on missing /
    /// malformed file) and stash the fallback captures dir for the
    /// `CapturesDirSource` impl.
    pub fn load(paths: Arc<AppPaths>) -> AppResult<Self> {
        let file = paths.data.join("settings.json");
        // Asked before the read so a *malformed* file — which also falls
        // back to defaults — is not mistaken for a first launch. Re-seeding
        // over a file the user has been using is exactly what must not
        // happen; better to leave a corrupt file on defaults than to
        // resurrect install-time answers over it.
        let first_launch = !file.exists();
        let state = read_or_log(&file);
        Ok(Self {
            file,
            fallback_captures: paths.captures.clone(),
            state: RwLock::new(state),
            first_launch,
        })
    }

    /// Carry the installer's answers into settings, once, on first launch.
    ///
    /// A no-op on every later launch and whenever no installer document was
    /// found. Runs before any window exists, so it writes the file and swaps
    /// the snapshot directly instead of going through
    /// [`SettingsService::update`] (there is no `AppHandle` to emit
    /// `settings/changed` on yet, and nothing has read the old values).
    ///
    /// Best-effort: a seed that cannot be persisted still applies in memory
    /// for this session, and the next `update` writes it. Failing startup
    /// because a preference could not be recorded would be absurd.
    pub fn seed_from_installer(&self, provisioning: &ProvisioningService) {
        if !self.first_launch {
            return;
        }
        let Some(doc) = provisioning.document() else {
            return;
        };

        let mut next = self.snapshot();
        let capabilities = provisioning.capabilities();
        provisioning_rules::seed_general_settings(doc, &capabilities, &mut next.general);
        if next == self.snapshot() {
            return;
        }

        if let Ok(mut guard) = self.state.write() {
            *guard = next.clone();
        }
        match write_file(&self.file, &next) {
            Ok(()) => tracing::info!(
                start_on_startup = next.general.start_on_startup,
                automatic_updates = next.general.automatic_updates,
                help_improve = next.general.help_improve,
                "seeded settings from the installer's choices"
            ),
            Err(e) => tracing::warn!(
                error = %e,
                "could not persist the installer-seeded settings — they apply \
                 for this session and will be written on the next change"
            ),
        }
    }

    /// Snapshot the current settings. Clones — callers shouldn't hold
    /// the read guard across awaits.
    pub fn snapshot(&self) -> Settings {
        self.state.read().map(|g| g.clone()).unwrap_or_default()
    }

    /// Default captures dir used when `general.captures_dir` is empty.
    /// The onboarding wizard reads this so the "Current location" hint
    /// shows a real OS path on first launch instead of the bare phrase
    /// "default".
    pub fn fallback_captures_dir(&self) -> PathBuf {
        self.fallback_captures.clone()
    }

    /// Live, clamped palette swatch count — the Palette-Capture default.
    /// `finish_palette_capture` reads this when the IPC call omits an
    /// explicit count, so changing it in settings takes effect on the
    /// next palette capture without a restart. Clamped on read so a
    /// hand-edited / out-of-range settings.json can't produce a nonsense
    /// count.
    pub fn palette_count(&self) -> usize {
        clippity_domain::palette::clamp_count(self.snapshot().capture.palette_count as usize)
    }

    /// Merge `patch` into the current state, validate, persist to
    /// disk, swap the snapshot, and emit `clippity://settings/changed`
    /// with the full new `Settings`.
    pub fn update(&self, app: &AppHandle, patch: SettingsPatch) -> AppResult<Settings> {
        let mut next = self.snapshot();
        apply_patch(&mut next, patch);
        validate(&next)?;
        ensure_captures_dir_exists(&next.general, &self.fallback_captures)?;

        write_file(&self.file, &next)?;
        {
            let mut guard = self
                .state
                .write()
                .map_err(|_| AppError::Settings("settings lock poisoned".into()))?;
            *guard = next.clone();
        }
        events::emit(app, events::names::SETTINGS_CHANGED, next.clone())?;
        Ok(next)
    }
}

impl CapturesDirSource for SettingsService {
    fn captures_dir(&self) -> PathBuf {
        let s = self.snapshot();
        let trimmed = s.general.captures_dir.trim();
        if trimmed.is_empty() {
            self.fallback_captures.clone()
        } else {
            PathBuf::from(trimmed)
        }
    }
}

impl ToastSettingsSource for SettingsService {
    fn toast_settings(&self) -> ToastDefaults {
        let s = self.snapshot();
        ToastDefaults {
            corner: s.notifications.corner,
            durations: s.notifications.durations,
        }
    }
}

impl CaptureEncodingSource for SettingsService {
    fn capture_compression(&self) -> CaptureCompression {
        self.snapshot().performance.capture_compression
    }
}

impl NameTemplateSource for SettingsService {
    fn name_template(&self) -> String {
        self.snapshot().general.name_template
    }
}

impl RecordingSettingsSource for SettingsService {
    fn recording(&self) -> settings::RecordingSettings {
        self.snapshot().recording
    }
}

// -------- Private helpers --------

fn apply_patch(target: &mut Settings, patch: SettingsPatch) {
    if let Some(general) = patch.general {
        target.general = general;
    }
    if let Some(mut appearance) = patch.appearance {
        // Clamp the loosely-stored numeric knobs on the way in so the
        // persisted + emitted value the frontend reads is always inside
        // the valid envelope (mirrors palette_count / confidence).
        appearance.window_opacity = settings::clamp_window_opacity(appearance.window_opacity);
        appearance.ui_scale = settings::clamp_ui_scale(appearance.ui_scale);
        target.appearance = appearance;
    }
    if let Some(notifications) = patch.notifications {
        target.notifications = notifications;
    }
    if let Some(performance) = patch.performance {
        target.performance = performance;
    }
    if let Some(mut capture) = patch.capture {
        // Clamp the loosely-stored delay length on the way in so the
        // persisted + emitted value the frontend seeds from is always
        // inside the valid envelope (mirrors appearance / confidence).
        // `palette_count` stays read-clamped by `palette_count()`.
        capture.delay_seconds = settings::clamp_delay_seconds(capture.delay_seconds);
        target.capture = capture;
    }
    if let Some(mut recording) = patch.recording {
        // Clamp both rates on the way in, for the same reason the delay
        // and opacity are clamped here: what is persisted and re-emitted
        // to every window has to be inside the envelope, so no reader
        // has to defend against a value the writer let through.
        recording.video_fps = recording.fps_for(recorder::RecorderFormat::Mp4);
        recording.gif_fps = recording.fps_for(recorder::RecorderFormat::Gif);
        target.recording = recording;
    }
    if let Some(models) = patch.models {
        target.models = models;
    }
    if let Some(shortcuts) = patch.shortcuts {
        target.shortcuts = shortcuts;
    }
}

fn validate(s: &Settings) -> AppResult<()> {
    if !settings::validate_accent_hex(&s.appearance.accent) {
        return Err(AppError::Settings(format!(
            "invalid accent hex: {}",
            s.appearance.accent
        )));
    }
    Ok(())
}

/// Make sure the active captures dir is writable. Empty override =
/// the fallback `AppPaths.captures` (already created at startup, this
/// is idempotent). Non-empty override = `fs::create_dir_all` so a
/// fresh user-chosen path works on the next capture.
fn ensure_captures_dir_exists(g: &GeneralSettings, fallback: &Path) -> AppResult<()> {
    let trimmed = g.captures_dir.trim();
    let target = if trimmed.is_empty() {
        fallback.to_path_buf()
    } else {
        PathBuf::from(trimmed)
    };
    fs::create_dir_all(&target).map_err(|e| AppError::Settings(format!("captures dir: {e}")))?;
    Ok(())
}

/// Load settings from disk, falling back to defaults — but **never
/// silently**. A missing file is the expected fresh-install case
/// (`debug`); a present-but-unreadable or malformed file is a data
/// problem the user needs to know about (`warn`), because it silently
/// reverts every setting to default. The on-disk file is left intact
/// until the next successful `update`, so the user can recover it.
fn read_or_log(path: &Path) -> Settings {
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Settings>(&text) {
            Ok(settings) => settings,
            Err(e) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "settings file is malformed — using defaults; the file is \
                     left untouched until the next save so it can be recovered"
                );
                Settings::default()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(
                path = %path.display(),
                "no settings file — using defaults (fresh install)"
            );
            Settings::default()
        }
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "could not read settings file — using defaults"
            );
            Settings::default()
        }
    }
}

fn write_file(path: &Path, s: &Settings) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(s)?;
    fs::write(path, json)?;
    Ok(())
}

// -------- Test-only static accessor impls --------

/// Static `CapturesDirSource` for test harnesses — returns the same
/// path on every call. Lives in the production module (behind
/// `cfg(any(test, feature = "test-support"))`) so consumer crates'
/// tests can use it without re-declaring the trait.
#[cfg(test)]
#[derive(Clone, Debug)]
pub struct StaticCapturesDir(pub PathBuf);

#[cfg(test)]
impl CapturesDirSource for StaticCapturesDir {
    fn captures_dir(&self) -> PathBuf {
        self.0.clone()
    }
}

/// Static `ToastSettingsSource` for test harnesses.
#[cfg(test)]
#[derive(Clone, Debug)]
pub struct StaticToastSettings(pub ToastDefaults);

#[cfg(test)]
impl ToastSettingsSource for StaticToastSettings {
    fn toast_settings(&self) -> ToastDefaults {
        self.0.clone()
    }
}

/// Static `NameTemplateSource` for test harnesses — returns the same
/// template on every call (a blank one selects the built-in default).
#[cfg(test)]
#[derive(Clone, Debug)]
pub struct StaticNameTemplate(pub String);

#[cfg(test)]
impl NameTemplateSource for StaticNameTemplate {
    fn name_template(&self) -> String {
        self.0.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEST_NONCE: AtomicU64 = AtomicU64::new(0);

    struct Harness {
        root: PathBuf,
        service: SettingsService,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn now_ms() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    fn harness() -> Harness {
        let n = TEST_NONCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("clippity-settings-test-{}-{n}", now_ms()));
        let data = root.join("data");
        let captures = root.join("captures");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&captures).unwrap();
        let paths = Arc::new(AppPaths {
            data,
            cache: root.clone(),
            captures,
            models: root.clone(),
        });
        Harness {
            service: SettingsService::load(paths).unwrap(),
            root,
        }
    }

    /// A harness whose `settings.json` already exists (so it is *not* a
    /// first launch), pre-written with `settings`.
    fn harness_with_existing_settings(settings: &Settings) -> Harness {
        let n = TEST_NONCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("clippity-settings-test-{}-{n}", now_ms()));
        let data = root.join("data");
        let captures = root.join("captures");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&captures).unwrap();
        write_file(&data.join("settings.json"), settings).unwrap();
        let paths = Arc::new(AppPaths {
            data,
            cache: root.clone(),
            captures,
            models: root.clone(),
        });
        Harness {
            service: SettingsService::load(paths).unwrap(),
            root,
        }
    }

    /// A `ProvisioningService` around a document written into a scratch dir.
    fn provisioning(tag: &str, body: &str) -> ProvisioningService {
        let n = TEST_NONCE.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("clippity-settings-prov-{tag}-{n}"));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(clippity_domain::provisioning::PROVISIONING_FILE);
        fs::write(&path, body).unwrap();
        ProvisioningService::from_path(&path)
    }

    /// An install where the user ticked start-at-login and cleared both
    /// "automatic updates" and "help improve".
    const OPTED_OUT: &str = r#"{
        "schemaVersion": 1,
        "components": ["core", "capture", "assoc", "startup"],
        "preferences": {
            "desktopShortcut": true,
            "startAtLogin": true,
            "automaticUpdates": false,
            "helpImprove": false,
            "fileAssociations": true
        }
    }"#;

    // ---------- load / snapshot ----------

    #[test]
    fn load_missing_file_returns_defaults() {
        let h = harness();
        assert_eq!(h.service.snapshot(), Settings::default());
    }

    // ---------- installer seeding ----------

    #[test]
    fn first_launch_seeds_the_installers_answers() {
        let h = harness();
        h.service.seed_from_installer(&provisioning("opted-out", OPTED_OUT));
        let s = h.service.snapshot();
        assert!(s.general.start_on_startup, "the user ticked start-at-login");
        assert!(!s.general.automatic_updates);
        assert!(!s.general.help_improve);
        // Persisted, not just held in memory — the next launch must agree.
        let text = fs::read_to_string(&h.service.file).unwrap();
        assert!(text.contains("\"automaticUpdates\": false"), "{text}");
    }

    #[test]
    fn a_later_launch_never_overwrites_what_the_user_changed() {
        // The user turned automatic updates back on after installing with
        // them off. A Repair (or any later launch) must leave that alone.
        let mut existing = Settings::default();
        existing.general.automatic_updates = true;
        existing.general.start_on_startup = false;
        let h = harness_with_existing_settings(&existing);

        h.service.seed_from_installer(&provisioning("later", OPTED_OUT));

        let s = h.service.snapshot();
        assert!(s.general.automatic_updates, "the user's choice survives");
        assert!(!s.general.start_on_startup);
    }

    #[test]
    fn seeding_is_a_noop_without_an_installer_document() {
        // A portable build or a development run: nothing to honor, and the
        // defaults must not be disturbed.
        let h = harness();
        let dir = std::env::temp_dir().join("clippity-settings-prov-absent");
        fs::create_dir_all(&dir).unwrap();
        let absent = ProvisioningService::from_path(
            &dir.join(clippity_domain::provisioning::PROVISIONING_FILE),
        );
        h.service.seed_from_installer(&absent);

        assert_eq!(h.service.snapshot(), Settings::default());
        assert!(
            !h.service.file.exists(),
            "a no-op seed must not create settings.json"
        );
    }

    #[test]
    fn seeding_does_not_enable_a_setting_the_install_cannot_offer() {
        // Start-at-login ticked but the startup helper declined — the app
        // hides that row, so it must not be seeded on behind it.
        let h = harness();
        h.service.seed_from_installer(&provisioning(
            "contradiction",
            r#"{
                "schemaVersion": 1,
                "components": ["core", "capture"],
                "preferences": { "startAtLogin": true }
            }"#,
        ));
        assert!(!h.service.snapshot().general.start_on_startup);
    }

    #[test]
    fn load_malformed_file_returns_defaults_silently() {
        let h = harness();
        fs::write(&h.service.file, "not json").unwrap();
        // Re-load explicitly using the same file path.
        let paths = Arc::new(AppPaths {
            data: h.service.file.parent().unwrap().to_path_buf(),
            cache: h.root.clone(),
            captures: h.service.fallback_captures.clone(),
            models: h.root.clone(),
        });
        let svc = SettingsService::load(paths).unwrap();
        assert_eq!(svc.snapshot(), Settings::default());
    }

    // ---------- CapturesDirSource ----------

    #[test]
    fn captures_dir_returns_fallback_when_override_is_empty() {
        let h = harness();
        assert_eq!(h.service.captures_dir(), h.service.fallback_captures);
    }

    #[test]
    fn captures_dir_returns_override_when_set() {
        let h = harness();
        let custom = h.root.join("user-captures");
        fs::create_dir_all(&custom).unwrap();
        {
            let mut g = h.service.state.write().unwrap();
            g.general.captures_dir = custom.to_string_lossy().into_owned();
        }
        assert_eq!(h.service.captures_dir(), custom);
    }

    #[test]
    fn captures_dir_treats_whitespace_only_as_empty() {
        let h = harness();
        {
            let mut g = h.service.state.write().unwrap();
            g.general.captures_dir = "   ".into();
        }
        assert_eq!(h.service.captures_dir(), h.service.fallback_captures);
    }

    // ---------- ToastSettingsSource ----------

    #[test]
    fn toast_settings_mirror_persisted_notifications() {
        let h = harness();
        {
            let mut g = h.service.state.write().unwrap();
            g.notifications.corner = clippity_domain::toast::ToastCorner::TopLeft;
            g.notifications.durations.error = 12_000;
        }
        let t = h.service.toast_settings();
        assert_eq!(t.corner, clippity_domain::toast::ToastCorner::TopLeft);
        assert_eq!(t.durations.error, 12_000);
    }

    #[test]
    fn toast_settings_default_when_nothing_persisted() {
        let h = harness();
        let t = h.service.toast_settings();
        let d = ToastDefaults::defaults();
        assert_eq!(t.corner, d.corner);
        assert_eq!(t.durations, d.durations);
    }

    // ---------- apply_patch ----------

    #[test]
    fn apply_patch_replaces_only_present_sections() {
        let mut s = Settings::default();
        s.appearance.accent = "#000000".into();
        apply_patch(
            &mut s,
            SettingsPatch {
                general: Some(GeneralSettings {
                    captures_dir: "/x".into(),
                    start_on_startup: true,
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(s.general.captures_dir, "/x");
        // Untouched section preserved.
        assert_eq!(s.appearance.accent, "#000000");
    }

    #[test]
    fn apply_patch_replaces_performance_section() {
        let mut s = Settings::default();
        apply_patch(
            &mut s,
            SettingsPatch {
                performance: Some(clippity_domain::settings::PerformanceSettings {
                    gpu_acceleration: false,
                    window_effects: false,
                    reduced_animations: true,
                    capture_compression: CaptureCompression::Small,
                }),
                ..Default::default()
            },
        );
        assert!(!s.performance.gpu_acceleration);
        assert!(!s.performance.window_effects);
        assert!(s.performance.reduced_animations);
        assert_eq!(s.performance.capture_compression, CaptureCompression::Small);
    }

    // ---------- CaptureEncodingSource ----------

    #[test]
    fn capture_compression_reflects_snapshot() {
        let h = harness();
        // Default ships Balanced.
        assert_eq!(
            h.service.capture_compression(),
            CaptureCompression::Balanced
        );
        {
            let mut g = h.service.state.write().unwrap();
            g.performance.capture_compression = CaptureCompression::Fast;
        }
        assert_eq!(h.service.capture_compression(), CaptureCompression::Fast);
    }

    // ---------- palette_count accessor + capture patch ----------

    #[test]
    fn palette_count_defaults_to_six() {
        let h = harness();
        assert_eq!(h.service.palette_count(), 6);
    }

    #[test]
    fn palette_count_clamps_out_of_range_persisted_value() {
        let h = harness();
        {
            let mut g = h.service.state.write().unwrap();
            g.capture.palette_count = 99;
        }
        assert_eq!(
            h.service.palette_count(),
            clippity_domain::palette::MAX_PALETTE_COUNT
        );
    }

    #[test]
    fn apply_patch_replaces_capture_section() {
        let mut s = Settings::default();
        apply_patch(
            &mut s,
            SettingsPatch {
                capture: Some(clippity_domain::settings::CaptureSettings {
                    palette_count: 10,
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(s.capture.palette_count, 10);
    }

    #[test]
    fn apply_patch_clamps_capture_delay_seconds() {
        // An out-of-envelope delay is clamped on write so the persisted +
        // emitted value the frontend seeds from is always valid.
        let mut s = Settings::default();
        apply_patch(
            &mut s,
            SettingsPatch {
                capture: Some(clippity_domain::settings::CaptureSettings {
                    delay: true,
                    delay_seconds: 250,
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(
            s.capture.delay_seconds,
            clippity_domain::settings::MAX_DELAY_SECONDS
        );
    }

    #[test]
    fn apply_patch_replaces_models_section() {
        // Regression: a dropped `models` arm here made every Models
        // setting snap back to its default (the slider "reset to 25%"
        // symptom) because the round-trip returned the unchanged value.
        let mut s = Settings::default();
        assert_eq!(s.models.confidence, 25);
        apply_patch(
            &mut s,
            SettingsPatch {
                models: Some(clippity_domain::settings::ModelsSettings {
                    auto_download: false,
                    object_model: "yolov10s".into(),
                    confidence: 40,
                }),
                ..Default::default()
            },
        );
        assert!(!s.models.auto_download);
        assert_eq!(s.models.object_model, "yolov10s");
        assert_eq!(s.models.confidence, 40);
    }

    #[test]
    fn apply_patch_replaces_shortcuts_section() {
        let mut s = Settings::default();
        let mut overrides = std::collections::BTreeMap::new();
        overrides.insert("editor:select-all".to_string(), vec!["Mod+Shift+A".to_string()]);
        apply_patch(
            &mut s,
            SettingsPatch {
                shortcuts: Some(clippity_domain::settings::ShortcutsSettings {
                    overrides,
                    global_capture: "Mod+Alt+3".into(),
                    global_capture_enabled: false,
                }),
                ..Default::default()
            },
        );
        assert_eq!(
            s.shortcuts.overrides.get("editor:select-all"),
            Some(&vec!["Mod+Shift+A".to_string()])
        );
        assert_eq!(s.shortcuts.global_capture, "Mod+Alt+3");
        assert!(!s.shortcuts.global_capture_enabled);
    }

    #[test]
    fn apply_patch_clamps_appearance_numeric_knobs() {
        let mut s = Settings::default();
        apply_patch(
            &mut s,
            SettingsPatch {
                appearance: Some(clippity_domain::settings::AppearanceSettings {
                    window_opacity: 3,  // below the 60 floor
                    ui_scale: 250,      // above the 120 ceiling
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
        assert_eq!(
            s.appearance.window_opacity,
            clippity_domain::settings::MIN_WINDOW_OPACITY_PCT
        );
        assert_eq!(
            s.appearance.ui_scale,
            clippity_domain::settings::MAX_UI_SCALE_PCT
        );
    }

    // ---------- validate ----------

    #[test]
    fn validate_rejects_bad_accent_hex() {
        let mut s = Settings::default();
        s.appearance.accent = "not-a-color".into();
        let err = validate(&s).unwrap_err();
        assert_eq!(err.code(), "settings");
    }

    #[test]
    fn validate_passes_default_settings() {
        validate(&Settings::default()).unwrap();
    }

    // ---------- file persistence ----------

    #[test]
    fn update_writes_settings_to_disk() {
        let h = harness();
        let custom = h.root.join("captures-2");
        let patch = SettingsPatch {
            general: Some(GeneralSettings {
                captures_dir: custom.to_string_lossy().into_owned(),
                onboarded: true,
                ..Default::default()
            }),
            ..Default::default()
        };
        let mut next = h.service.snapshot();
        apply_patch(&mut next, patch);
        validate(&next).unwrap();
        ensure_captures_dir_exists(&next.general, &h.service.fallback_captures).unwrap();
        write_file(&h.service.file, &next).unwrap();
        assert!(h.service.file.exists());
        let text = fs::read_to_string(&h.service.file).unwrap();
        assert!(text.contains("\"capturesDir\""));
        assert!(text.contains("captures-2"));
    }

    #[test]
    fn write_then_load_round_trips() {
        let h = harness();
        let mut s = Settings::default();
        s.general.start_on_startup = true;
        s.appearance.accent = "#aabbcc".into();
        write_file(&h.service.file, &s).unwrap();
        let paths = Arc::new(AppPaths {
            data: h.service.file.parent().unwrap().to_path_buf(),
            cache: h.root.clone(),
            captures: h.service.fallback_captures.clone(),
            models: h.root.clone(),
        });
        let svc = SettingsService::load(paths).unwrap();
        let back = svc.snapshot();
        assert!(back.general.start_on_startup);
        assert_eq!(back.appearance.accent, "#aabbcc");
    }

    #[test]
    fn ensure_captures_dir_creates_missing_override_dir() {
        let h = harness();
        let target = h.root.join("brand-new-dir/nested");
        let g = GeneralSettings {
            captures_dir: target.to_string_lossy().into_owned(),
            ..Default::default()
        };
        ensure_captures_dir_exists(&g, &h.service.fallback_captures).unwrap();
        assert!(target.is_dir());
    }
}
