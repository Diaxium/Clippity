//! Diagnostics orchestration — what Settings → Advanced reads, and the
//! bundle it exports.
//!
//! Everything here answers one of two questions: *what is this
//! installation?* (versions, paths, monitors, what is registered) and
//! *what happened?* (the log, the caches, the last recording). Both are
//! read-mostly and cheap; the one destructive corner —
//! [`DiagnosticsService::clear_cache`] — is confined to a fixed enum of
//! targets so the command surface can never be handed a path to delete.
//!
//! Nothing here transmits anything. A bundle is written to a folder the
//! user is then shown; sending it anywhere is their action, in their
//! mail client, with the redaction they chose already applied.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clippity_domain::developer::{
    BundleOptions, BundleResult, CacheTarget, DiagnosticPaths, FolderTarget, MonitorDiagnostics,
    Redaction, RuntimeStatus, ShortcutDiagnostics, SystemInfo, WindowDiagnostics,
};
use clippity_domain::naming::LocalTime;
use clippity_infra::error::{AppError, AppResult};
use clippity_infra::paths::AppPaths;
use clippity_infra::{logging, runtime};
use xcap::Monitor;

use crate::capture_io::local_now;

/// Folder inside the data directory that exported bundles land in. One
/// place, so a user who exports three of them while chasing a bug has
/// them together rather than scattered across whatever folder was
/// last used.
pub const BUNDLE_DIR: &str = "diagnostics";

/// Cap on how much of the log goes into one bundle, in bytes. A 64 MiB
/// retained set is legitimate for a long session, but nobody is going
/// to be sent it — the tail is what carries the failure.
const BUNDLE_LOG_BYTES: u64 = 4 * 1024 * 1024;

pub struct DiagnosticsService {
    paths: Arc<AppPaths>,
}

impl DiagnosticsService {
    pub fn new(paths: Arc<AppPaths>) -> Self {
        Self { paths }
    }

    /// The log directory — `<data>/logs`. Created lazily by the logging
    /// sink; this is the path either way, so "open the log folder" works
    /// before the first line is written.
    pub fn logs_dir(&self) -> PathBuf {
        self.paths.data.join("logs")
    }

    /// The folder exported bundles land in.
    pub fn bundles_dir(&self) -> PathBuf {
        self.paths.data.join(BUNDLE_DIR)
    }

    /// The app's own directories, as this process resolved them.
    pub fn diagnostic_paths(&self) -> DiagnosticPaths {
        DiagnosticPaths {
            data: display(&self.paths.data),
            cache: display(&self.paths.cache),
            captures: display(&self.paths.captures),
            models: display(&self.paths.models),
            logs: display(&self.logs_dir()),
            executable: std::env::current_exe()
                .map(|p| display(&p))
                .unwrap_or_default(),
            settings_file: display(&self.paths.data.join("settings.json")),
        }
    }

    /// Describe every monitor as the capture pipeline sees it.
    ///
    /// Returns an empty list rather than an error when enumeration
    /// fails: this is a diagnostics card, and "no monitors listed" is
    /// itself the diagnosis in the one case where it happens.
    pub fn monitors(&self) -> Vec<MonitorDiagnostics> {
        let Ok(monitors) = Monitor::all() else {
            tracing::warn!("diagnostics: could not enumerate monitors");
            return Vec::new();
        };
        monitors.iter().map(describe_monitor).collect()
    }

    /// Everything the "Copy system information" action puts on the
    /// clipboard, and the first file in an exported bundle.
    pub fn system_info(
        &self,
        webview_version: Option<String>,
        installed_models: Vec<String>,
    ) -> SystemInfo {
        SystemInfo {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            build_profile: if cfg!(debug_assertions) {
                "debug".into()
            } else {
                "release".into()
            },
            safe_mode: runtime::is_safe_mode(),
            portable: clippity_infra::paths::portable_root().is_some(),
            os: std::env::consts::OS.to_string(),
            os_version: os_version(),
            arch: std::env::consts::ARCH.to_string(),
            webview_version,
            cpu_count: std::thread::available_parallelism()
                .map(|n| n.get() as u32)
                .unwrap_or(0),
            paths: self.diagnostic_paths(),
            monitors: self.monitors(),
            installed_models,
            log_file: logging::current_file().map(|p| display(&p)),
            log_bytes: logging::total_bytes(),
            uptime_ms: runtime::uptime_ms(),
        }
    }

    /// Live runtime state — windows, shielding, the global hotkey, the
    /// index, the caches.
    pub fn runtime_status(
        &self,
        windows: Vec<WindowDiagnostics>,
        capture_shielded: bool,
        global_capture: ShortcutDiagnostics,
        global_hotkeys_installed: bool,
    ) -> RuntimeStatus {
        let library_db = self.paths.data.join(crate::library_index::DB_FILE_NAME);
        RuntimeStatus {
            windows,
            capture_shielded,
            global_capture,
            global_hotkeys_installed,
            library_db_bytes: fs::metadata(&library_db).map(|m| m.len()).unwrap_or(0),
            library_db: display(&library_db),
            cache_bytes: dir_size(&self.paths.cache),
            monitors: self.monitors(),
        }
    }

    /// Write a diagnostics bundle and return where it landed.
    ///
    /// The bundle is a **folder**, not an archive: it is written with no
    /// compression dependency, a user can look inside before sending it
    /// (which is the point of offering redaction at all), and Explorer's
    /// own "Send to → Compressed folder" turns it into a zip in one
    /// click when someone asks for a single file.
    ///
    /// `system_json` and `settings_json` are passed in rather than read
    /// here so this stays independent of the settings service — the
    /// command layer already holds both.
    pub fn export_bundle(
        &self,
        options: &BundleOptions,
        system_json: &str,
        settings_json: &str,
    ) -> AppResult<BundleResult> {
        let redaction = if options.redact_paths || options.redact_capture_names {
            Redaction::new(options, &account_name(), &home_dir())
        } else {
            Redaction::none()
        };

        let dir = self.bundles_dir().join(bundle_folder_name(local_now()));
        fs::create_dir_all(&dir)
            .map_err(|e| AppError::Settings(format!("diagnostics bundle: {e}")))?;

        let mut files = Vec::new();
        write_redacted(&dir, "system.json", system_json, &redaction, &mut files)?;
        if options.include_settings {
            write_redacted(&dir, "settings.json", settings_json, &redaction, &mut files)?;
        }
        if options.include_logs {
            // Flush first, or the bundle is missing the very lines that
            // describe the failure being reported.
            logging::flush();
            for (index, path) in logging::log_files().iter().enumerate() {
                let Ok(text) = read_capped(path, BUNDLE_LOG_BYTES) else {
                    continue;
                };
                let name = match index {
                    0 => "logs/clippity.log".to_string(),
                    n => format!("logs/clippity.{n}.log"),
                };
                write_redacted(&dir, &name, &text, &redaction, &mut files)?;
            }
        }

        let bytes = dir_size(&dir);
        tracing::info!(
            path = %dir.display(),
            files = files.len(),
            redacted = redaction.is_active(),
            "diagnostics bundle exported"
        );
        Ok(BundleResult {
            path: display(&dir),
            files,
            bytes,
            redacted: redaction.is_active(),
        })
    }

    /// Delete one cache, returning how many bytes went.
    ///
    /// Every target is a directory this app owns and can rebuild.
    /// `Logs` is routed through the logging sink rather than deleted
    /// here, because the live file is open in this process.
    pub fn clear_cache(&self, target: CacheTarget) -> AppResult<u64> {
        let freed = match target {
            CacheTarget::Logs => {
                let before = logging::total_bytes();
                logging::clear().map_err(|e| AppError::Settings(format!("clear logs: {e}")))?;
                before
            }
            CacheTarget::Thumbnails => clear_dir(&self.paths.cache.join("thumbnails"))?,
            CacheTarget::Temp => {
                clear_dir(&self.paths.cache.join("tmp"))?
                    + clear_dir(&self.paths.cache.join("staging"))?
            }
            CacheTarget::Models => clear_dir(&self.paths.models)?,
            CacheTarget::Webview => {
                // Sits beside `data\`, not inside it — see
                // `paths::webview_data_dir`. Deleting it under the
                // running process is safe because WebView2 recreates it
                // on the next launch, which is why this one needs a
                // restart to take effect.
                let root = self.paths.data.parent().map(|p| p.join("webview"));
                match root {
                    Some(dir) => clear_dir(&dir)?,
                    None => 0,
                }
            }
        };
        tracing::info!(target = target.label(), freed, "cache cleared");
        Ok(freed)
    }

    /// Resolve a [`FolderTarget`] to a real directory.
    ///
    /// `captures` takes the live captures dir (user override included)
    /// rather than `AppPaths.captures`, because "open the captures
    /// folder" has to open the one captures are actually going to.
    pub fn folder(&self, target: FolderTarget, captures_dir: &Path) -> PathBuf {
        match target {
            FolderTarget::Data => self.paths.data.clone(),
            FolderTarget::Logs => self.logs_dir(),
            FolderTarget::Captures => captures_dir.to_path_buf(),
            FolderTarget::Cache => self.paths.cache.clone(),
            FolderTarget::Models => self.paths.models.clone(),
            FolderTarget::Bundles => self.bundles_dir(),
            FolderTarget::Install => std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| self.paths.data.clone()),
        }
    }

    /// Open one of the app's folders in the OS file manager, creating it
    /// first when it doesn't exist yet.
    ///
    /// The create is deliberate: `logs` and `diagnostics` are made
    /// lazily by whatever writes them, and a button that errors with
    /// "not found" the first time it is pressed would read as a bug.
    pub fn open_folder(&self, target: FolderTarget, captures_dir: &Path) -> AppResult<PathBuf> {
        let dir = self.folder(target, captures_dir);
        if !dir.is_dir() {
            fs::create_dir_all(&dir)
                .map_err(|e| AppError::Settings(format!("open {}: {e}", target.label())))?;
        }
        tauri_plugin_opener::open_path(&dir, None::<&str>)
            .map_err(|e| AppError::Settings(format!("open {}: {e}", target.label())))?;
        Ok(dir)
    }

    /// Arm safe mode for the next launch.
    pub fn arm_safe_mode(&self) -> AppResult<()> {
        runtime::arm_safe_mode(&self.paths.data)
            .map(|_| ())
            .map_err(|e| AppError::Settings(format!("safe mode: {e}")))
    }
}

/// `clippity-diagnostics-2026-08-04-143012` — sortable, and unique
/// enough that two exports a minute apart don't collide.
fn bundle_folder_name(t: LocalTime) -> String {
    format!(
        "clippity-diagnostics-{:04}-{:02}-{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

/// Write one bundle file, redacted, recording its name.
fn write_redacted(
    dir: &Path,
    name: &str,
    contents: &str,
    redaction: &Redaction,
    files: &mut Vec<String>,
) -> AppResult<()> {
    let path = dir.join(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Settings(format!("diagnostics bundle: {e}")))?;
    }
    fs::write(&path, redaction.apply(contents))
        .map_err(|e| AppError::Settings(format!("diagnostics bundle: {e}")))?;
    files.push(name.to_string());
    Ok(())
}

/// Read at most `max` bytes from the end of a file, as lossy UTF-8.
fn read_capped(path: &Path, max: u64) -> std::io::Result<String> {
    use std::io::{Read, Seek, SeekFrom};

    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(max)))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Delete the contents of `dir`, returning the bytes freed. A missing
/// directory frees nothing and is not an error — that is what "already
/// clear" looks like.
fn clear_dir(dir: &Path) -> AppResult<u64> {
    if !dir.is_dir() {
        return Ok(0);
    }
    let before = dir_size(dir);
    for entry in fs::read_dir(dir).map_err(|e| AppError::Settings(format!("clear: {e}")))? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        // Best-effort per entry: one locked file must not abandon the
        // rest of the sweep.
        let _ = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
    }
    Ok(before.saturating_sub(dir_size(dir)))
}

/// Recursive size of a directory tree, in bytes.
///
/// Iterative rather than recursive so a pathological tree can't blow the
/// stack, and symlink-free (`metadata` on the entry, not `read_link`)
/// so a junction pointing at `C:\` can't turn a cache-size readout into
/// a full-disk walk.
pub fn dir_size(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push(entry.path());
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

/// One monitor, described. Every field degrades to a neutral value
/// rather than failing the whole listing: a monitor that won't report
/// its refresh rate is still worth showing.
fn describe_monitor(m: &Monitor) -> MonitorDiagnostics {
    let x = m.x().unwrap_or(0);
    let y = m.y().unwrap_or(0);
    let (hdr, sdr_white_nits) = describe_color_at(x, y);
    MonitorDiagnostics {
        id: m.id().unwrap_or(0),
        name: m.name().unwrap_or_else(|_| "unknown".into()),
        x,
        y,
        width: m.width().unwrap_or(0),
        height: m.height().unwrap_or(0),
        scale: m.scale_factor().unwrap_or(1.0),
        refresh_hz: m.frequency().unwrap_or(0.0),
        primary: m.is_primary().unwrap_or(false),
        hdr,
        sdr_white_nits,
    }
}

#[cfg(target_os = "windows")]
fn describe_color_at(x: i32, y: i32) -> (bool, Option<f32>) {
    // A point one pixel inside the monitor's origin: the origin itself
    // is shared with the neighbouring display's edge on some layouts.
    match clippity_platform::windows::hdr_display::describe_at(x + 1, y + 1) {
        Some(info) => (info.hdr_active, Some(info.sdr_white_nits)),
        None => (false, None),
    }
}

#[cfg(not(target_os = "windows"))]
fn describe_color_at(_x: i32, _y: i32) -> (bool, Option<f32>) {
    (false, None)
}

#[cfg(target_os = "windows")]
fn os_version() -> String {
    clippity_platform::windows::os_info::describe()
}

#[cfg(not(target_os = "windows"))]
fn os_version() -> String {
    std::env::consts::OS.to_string()
}

/// The account this process runs as, for redaction. Empty when
/// unreadable, which the redaction rules treat as "don't match names".
fn account_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_default()
}

/// The user's profile directory, for redaction.
fn home_dir() -> String {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default()
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NONCE: AtomicU64 = AtomicU64::new(0);

    struct Harness {
        root: PathBuf,
        service: DiagnosticsService,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn harness(label: &str) -> Harness {
        let n = NONCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("clippity-diagnostics-{label}-{n}"));
        let data = root.join("data");
        let cache = root.join("cache");
        let captures = data.join("captures");
        let models = root.join("models");
        for dir in [&data, &cache, &captures, &models] {
            fs::create_dir_all(dir).unwrap();
        }
        let paths = Arc::new(AppPaths {
            data,
            cache,
            captures,
            models,
        });
        Harness {
            service: DiagnosticsService::new(paths),
            root,
        }
    }

    #[test]
    fn a_bundle_folder_name_sorts_chronologically() {
        let name = bundle_folder_name(LocalTime {
            year: 2026,
            month: 8,
            day: 4,
            hour: 14,
            minute: 30,
            second: 12,
        });
        assert_eq!(name, "clippity-diagnostics-2026-08-04-143012");
    }

    #[test]
    fn a_bundle_writes_the_files_it_says_it_did() {
        let h = harness("bundle");
        let result = h
            .service
            .export_bundle(
                &BundleOptions {
                    include_logs: false,
                    ..Default::default()
                },
                r#"{"appVersion":"0.1.0"}"#,
                r#"{"general":{}}"#,
            )
            .unwrap();

        assert_eq!(result.files, vec!["system.json", "settings.json"]);
        let dir = PathBuf::from(&result.path);
        for name in &result.files {
            assert!(dir.join(name).is_file(), "missing {name}");
        }
        assert!(result.bytes > 0);
    }

    #[test]
    fn a_bundle_redacts_what_it_writes() {
        let h = harness("redact");
        let options = BundleOptions::default();
        let result = h
            .service
            .export_bundle(
                &options,
                &format!(
                    r#"{{"captures":"{}\\shot.png"}}"#,
                    home_dir().replace('\\', "\\\\")
                ),
                "{}",
            )
            .unwrap();

        assert!(result.redacted);
        let text = fs::read_to_string(PathBuf::from(&result.path).join("system.json")).unwrap();
        assert!(text.contains("<capture>.png"), "{text}");
        if !home_dir().is_empty() {
            assert!(!text.contains(&home_dir()), "{text}");
        }
    }

    #[test]
    fn an_unredacted_bundle_says_so() {
        let h = harness("plain");
        let result = h
            .service
            .export_bundle(
                &BundleOptions {
                    redact_paths: false,
                    redact_capture_names: false,
                    include_logs: false,
                    include_settings: false,
                },
                r#"{"x":"shot.png"}"#,
                "{}",
            )
            .unwrap();

        assert!(!result.redacted);
        assert_eq!(result.files, vec!["system.json"]);
        let text = fs::read_to_string(PathBuf::from(&result.path).join("system.json")).unwrap();
        assert!(text.contains("shot.png"));
    }

    #[test]
    fn clearing_a_cache_reports_the_bytes_it_freed() {
        let h = harness("clear");
        let thumbs = h.service.paths.cache.join("thumbnails");
        fs::create_dir_all(thumbs.join("nested")).unwrap();
        fs::write(thumbs.join("a.bin"), vec![0u8; 512]).unwrap();
        fs::write(thumbs.join("nested").join("b.bin"), vec![0u8; 256]).unwrap();

        let freed = h.service.clear_cache(CacheTarget::Thumbnails).unwrap();
        assert_eq!(freed, 768);
        assert_eq!(dir_size(&thumbs), 0);
        // The directory itself survives — the next thumbnail write
        // shouldn't have to recreate it.
        assert!(thumbs.is_dir());
    }

    #[test]
    fn clearing_a_cache_that_does_not_exist_is_not_an_error() {
        let h = harness("clear-missing");
        assert_eq!(h.service.clear_cache(CacheTarget::Thumbnails).unwrap(), 0);
    }

    #[test]
    fn directory_size_walks_the_whole_tree() {
        let h = harness("size");
        let deep = h.service.paths.cache.join("a/b/c");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("f.bin"), vec![7u8; 100]).unwrap();
        fs::write(h.service.paths.cache.join("g.bin"), vec![7u8; 23]).unwrap();
        assert_eq!(dir_size(&h.service.paths.cache), 123);
    }

    #[test]
    fn system_info_describes_this_process() {
        let h = harness("system");
        let info = h
            .service
            .system_info(Some("120.0.0".into()), vec!["ui-elements".into()]);
        assert_eq!(info.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(info.build_profile, "debug");
        assert_eq!(info.webview_version.as_deref(), Some("120.0.0"));
        assert_eq!(info.installed_models, vec!["ui-elements".to_string()]);
        assert!(info.paths.data.contains("clippity-diagnostics-system"));
        assert!(info.cpu_count >= 1);
    }
}
