//! Resolved filesystem locations the installer reads and writes.
//!
//! Kept deliberately small: an installer touches far fewer places than
//! the app it installs. The paths mirror the app's own convention — all
//! Clippity data lives under a single `Clippity` folder, not the bundle
//! identifier — so the uninstaller can find (and optionally remove) it.

use std::path::PathBuf;

/// The one folder name every Clippity install writes under, in both
/// `%APPDATA%` and `%LOCALAPPDATA%`. Matches the app's
/// `clippity_infra::paths::DATA_DIR_NAME`.
pub const DATA_DIR_NAME: &str = "Clippity";

/// Default install destination when the user doesn't override it.
pub const DEFAULT_INSTALL_DIR: &str = r"C:\Program Files\Clippity";

/// Sub-directory name (under the maintenance root) that holds the
/// installation manifest, the uninstaller copy, package cache, and logs.
pub const MAINTENANCE_DIR_NAME: &str = "maintenance";

/// The set of locations an install / uninstall operates on.
#[derive(Debug, Clone)]
pub struct InstallerPaths {
    /// Program files destination (user-overridable in the Options step).
    pub install_dir: PathBuf,
    /// Roaming app data (`%APPDATA%\Clippity`) — settings, presets.
    pub app_data: PathBuf,
    /// Local app data (`%LOCALAPPDATA%\Clippity`) — caches, thumbnails.
    pub local_data: PathBuf,
    /// Machine-wide data (`%PROGRAMDATA%\Clippity`) — the per-machine
    /// maintenance root.
    pub program_data: PathBuf,
    /// This run's log file.
    pub log_file: PathBuf,
}

impl InstallerPaths {
    /// Resolve paths from the environment, falling back to sane defaults
    /// when a variable is missing (e.g. non-Windows dev machines).
    pub fn resolve(install_dir: impl Into<PathBuf>) -> Self {
        let app_data = env_dir("APPDATA").join(DATA_DIR_NAME);
        let local_data = env_dir("LOCALAPPDATA").join(DATA_DIR_NAME);
        let program_data = env_dir("PROGRAMDATA").join(DATA_DIR_NAME);
        let log_file = local_data.join("logs").join("setup.log");
        Self {
            install_dir: install_dir.into(),
            app_data,
            local_data,
            program_data,
            log_file,
        }
    }

    /// Resolve with the default install destination.
    pub fn resolve_default() -> Self {
        Self::resolve(DEFAULT_INSTALL_DIR)
    }

    /// The maintenance root for a scope: `%PROGRAMDATA%\Clippity\maintenance`
    /// for an all-users install (survives outside Program Files so uninstall
    /// can delete the install dir freely), or
    /// `%LOCALAPPDATA%\Clippity\maintenance` for a per-user install.
    pub fn maintenance_dir(&self, all_users: bool) -> PathBuf {
        let root = if all_users { &self.program_data } else { &self.local_data };
        root.join(MAINTENANCE_DIR_NAME)
    }
}

/// Read a directory-valued env var, falling back to the current dir so
/// the code stays usable off-Windows.
fn env_dir(key: &str) -> PathBuf {
    std::env::var_os(key)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}
