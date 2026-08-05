//! Centralized app directories. Anything that needs to read/write
//! user data goes through `AppPaths` rather than calling Tauri's path
//! resolver directly.
//!
//! Everything for a given process lives under a **single root** so a user
//! sees exactly one Clippity folder, never a scatter of Roaming/Local/
//! reverse-DNS directories. An **installed** Clippity roots at
//! `%LOCALAPPDATA%\Clippity`; a **portable** one roots at a `Data` folder
//! beside the executable, so the whole app travels on a USB stick and
//! leaves nothing behind — see [`portable_root`]. Both share the same
//! sub-layout: `data\` (settings, library DB, captures), `cache\`,
//! `models\`, and `webview\`.
//!
//! Older builds split installed data across `%APPDATA%\Clippity` (Roaming)
//! and `%LOCALAPPDATA%\Clippity` (Local). [`migrate_legacy_layout`] folds
//! that split into the single root on the first boot after upgrading.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

/// On-disk name of the single root folder that holds all Clippity user
/// data — `%LOCALAPPDATA%\Clippity` on an installed Windows machine.
///
/// Deliberately the product name, NOT the bundle identifier
/// (`com.clippity.app`). The identifier stays reverse-DNS so OS-level
/// bundling, installer, and single-instance registration are correct,
/// while user-visible storage gets a clean, mainstream-looking folder —
/// the same split Electron apps use (`%APPDATA%\Discord`, not a
/// reverse-DNS folder). `apply_gpu_preference` in `lib.rs` reuses this
/// constant to locate `settings.json` during early boot.
pub const DATA_DIR_NAME: &str = "Clippity";

/// Marker file that switches Clippity into portable mode.
///
/// Its presence beside the executable is the whole trigger — no registry
/// key, no environment variable, nothing outside the folder. Deleting it
/// turns the same binary back into a normal installed app, and the
/// portable build script is the only thing that creates it.
pub const PORTABLE_MARKER: &str = "Clippity.portable";

/// Folder beside the executable that holds all data in portable mode.
pub const PORTABLE_DIR_NAME: &str = "Data";

/// Resolved once per process: portable mode cannot change at run time,
/// and three separate boot paths ask about it.
static PORTABLE_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The portable data root for this process, or `None` when installed.
///
/// Queried during early boot (before Tauri exists) as well as from
/// [`AppPaths::resolve`], so it deliberately depends on nothing but the
/// executable's own location.
pub fn portable_root() -> Option<&'static Path> {
    PORTABLE_ROOT
        .get_or_init(|| {
            let exe = std::env::current_exe().ok()?;
            let dir = exe.parent()?;
            portable_root_in(dir)
        })
        .as_deref()
}

/// The portable root implied by `exe_dir`, if it is marked portable.
///
/// Split out from [`portable_root`] so the rule is testable without
/// relocating the test binary.
fn portable_root_in(exe_dir: &Path) -> Option<PathBuf> {
    exe_dir
        .join(PORTABLE_MARKER)
        .is_file()
        .then(|| exe_dir.join(PORTABLE_DIR_NAME))
}

/// The single root that holds every Clippity folder for this process:
/// `<exe>\Data` in portable mode, otherwise `%LOCALAPPDATA%\Clippity`.
///
/// All other locations ([`AppPaths`], [`webview_data_dir`]) are derived
/// from this, so there is exactly one place data can live.
pub fn app_root(app: &AppHandle) -> AppResult<PathBuf> {
    if let Some(root) = portable_root() {
        return Ok(root.to_path_buf());
    }
    Ok(app
        .path()
        .local_data_dir()
        .map_err(|e| AppError::Settings(format!("local_data_dir: {e}")))?
        .join(DATA_DIR_NAME))
}

/// The WebView2 user-data directory: `webview\` under the single root.
///
/// WebView2 creates its own `EBWebView` subfolder inside this, keeping the
/// browser cache tucked under the app root instead of at
/// `%LOCALAPPDATA%\<identifier>`.
pub fn webview_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app_root(app)?.join("webview"))
}

/// The `settings.json` path, resolved without a Tauri handle.
///
/// Needed by the GPU-preference read that runs before Tauri is built, so
/// it cannot go through the path resolver. Mirrors what
/// [`AppPaths::resolve`] would produce for the same process: `settings.json`
/// under `data\` beneath the single root. On the very first boot after an
/// upgrade this runs before [`migrate_legacy_layout`], so it may not find
/// the file yet — that is a benign miss (GPU stays on, the default) and
/// self-corrects once migration has moved the file into place.
pub fn early_settings_file() -> Option<PathBuf> {
    Some(early_data_dir()?.join("settings.json"))
}

/// The `data\` directory, resolved without a Tauri handle.
///
/// Same early-boot constraint as [`early_settings_file`], and the same
/// caveat: on the first boot after an upgrade this runs before
/// [`migrate_legacy_layout`], so the directory may not be populated yet.
/// Used by the safe-mode marker, which has to be read before the first
/// webview exists.
pub fn early_data_dir() -> Option<PathBuf> {
    let root = match portable_root() {
        Some(root) => root.to_path_buf(),
        None => PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(DATA_DIR_NAME),
    };
    Some(root.join("data"))
}

#[derive(Debug, Clone)]
pub struct AppPaths {
    /// Per-user persistent app data (settings, library DB).
    pub data: PathBuf,
    /// Per-user cache (thumbnails, sidecar binaries, downloaded models).
    pub cache: PathBuf,
    /// Captured images and recordings.
    pub captures: PathBuf,
    /// Vision model + sidecar runtime.
    pub models: PathBuf,
}

impl AppPaths {
    pub fn resolve(app: &AppHandle) -> AppResult<Self> {
        // One root for everything (see `app_root`); each folder is a fixed
        // subdirectory of it, so installed and portable builds share an
        // identical on-disk shape and a user only ever sees one folder.
        let root = app_root(app)?;
        let data = root.join("data");
        let cache = root.join("cache");
        let captures = data.join("captures");
        let models = root.join("models");

        // Ensure layout exists. Idempotent — safe on every boot.
        for dir in [&data, &cache, &captures, &models] {
            std::fs::create_dir_all(dir)?;
        }

        Ok(Self {
            data,
            cache,
            captures,
            models,
        })
    }
}

/// Fold an older split layout into the single root, once, on boot.
///
/// Pre-consolidation installs kept user data in `%APPDATA%\Clippity`
/// (Roaming) and the WebView2 cache directly under `%LOCALAPPDATA%\Clippity`.
/// The new root *is* `%LOCALAPPDATA%\Clippity`, so `models\` already sits in
/// the right place and only two things need doing:
///
/// 1. Move the Roaming payload (settings, library DB, `last-region.json`,
///    `captures\`) into `data\` under the root.
/// 2. Drop the orphaned top-level `EBWebView` cache — WebView2 now recreates
///    it under `webview\`.
///
/// Best-effort and idempotent: it never clobbers a file that already exists
/// at the destination (so a half-finished move just resumes), and every step
/// swallows its error — a migration that can't complete must not stop the app
/// from booting. Portable mode never had the split, so it is skipped.
pub fn migrate_legacy_layout(app: &AppHandle) {
    if portable_root().is_some() {
        return;
    }
    let Ok(root) = app_root(app) else {
        return;
    };

    // 1) Roaming\Clippity\* -> root\data\*
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let legacy = PathBuf::from(appdata).join(DATA_DIR_NAME);
        let new_data = root.join("data");
        // Guard against APPDATA and LOCALAPPDATA ever resolving equal.
        if legacy.is_dir() && legacy != new_data {
            if std::fs::create_dir_all(&new_data).is_ok() {
                move_dir_contents(&legacy, &new_data);
            }
            // Remove the source only if the move emptied it; a leftover
            // entry (e.g. a locked DB) keeps the folder and is retried next
            // boot rather than silently abandoned.
            let _ = std::fs::remove_dir(&legacy);
        }
    }

    // 2) Legacy top-level WebView2 cache is disposable and now lives under
    //    `webview\`; delete the orphan so the root stays tidy.
    let _ = std::fs::remove_dir_all(root.join("EBWebView"));
}

/// Move each direct child of `from` into `to`, skipping any name that
/// already exists at the destination so already-migrated data is never
/// overwritten. Same-volume renames make this atomic per entry.
fn move_dir_contents(from: &Path, to: &Path) {
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten() {
        let dest = to.join(entry.file_name());
        if dest.exists() {
            continue;
        }
        let _ = std::fs::rename(entry.path(), dest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory unique to `label`, cleaned before use.
    fn scratch(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("clippity-paths-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn plain_folder_is_not_portable() {
        let dir = scratch("plain");
        assert_eq!(portable_root_in(&dir), None);
    }

    #[test]
    fn marker_file_selects_the_data_folder_beside_the_exe() {
        let dir = scratch("marked");
        std::fs::write(dir.join(PORTABLE_MARKER), "").expect("marker");
        assert_eq!(portable_root_in(&dir), Some(dir.join(PORTABLE_DIR_NAME)));
    }

    #[test]
    fn a_directory_named_like_the_marker_does_not_count() {
        // `is_file` rather than `exists`: a stray folder of the same name
        // must not silently redirect every write beside the executable.
        let dir = scratch("marker-dir");
        std::fs::create_dir_all(dir.join(PORTABLE_MARKER)).expect("marker dir");
        assert_eq!(portable_root_in(&dir), None);
    }

    #[test]
    fn move_dir_contents_relocates_files_and_folders() {
        let base = scratch("move");
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(from.join("captures")).expect("from");
        std::fs::create_dir_all(&to).expect("to");
        std::fs::write(from.join("library.db"), b"db").expect("db");
        std::fs::write(from.join("captures").join("a.png"), b"img").expect("img");

        move_dir_contents(&from, &to);

        assert_eq!(std::fs::read(to.join("library.db")).unwrap(), b"db");
        assert!(to.join("captures").join("a.png").is_file());
        // Source entries were renamed away, so the folder is now empty.
        assert_eq!(std::fs::read_dir(&from).unwrap().count(), 0);
    }

    #[test]
    fn move_dir_contents_never_clobbers_existing_destination() {
        let base = scratch("move-skip");
        let from = base.join("from");
        let to = base.join("to");
        std::fs::create_dir_all(&from).expect("from");
        std::fs::create_dir_all(&to).expect("to");
        std::fs::write(from.join("settings.json"), b"old").expect("old");
        std::fs::write(to.join("settings.json"), b"new").expect("new");

        move_dir_contents(&from, &to);

        // The already-present (newer) file wins; the source copy is left
        // behind rather than overwriting migrated data.
        assert_eq!(std::fs::read(to.join("settings.json")).unwrap(), b"new");
        assert!(from.join("settings.json").is_file());
    }
}
