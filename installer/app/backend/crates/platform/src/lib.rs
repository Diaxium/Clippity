//! `installer-platform` — OS-specific installer operations.
//!
//! Higher layers speak in domain terms ("register an uninstall entry",
//! "create a desktop shortcut", "am I elevated?"). The cross-platform
//! [`windows_ops`] facade is the surface they call; it delegates to the
//! real Win32 implementations (in the `windows` module) on Windows and
//! degrades to logged no-ops elsewhere, so the workspace type-checks on
//! any dev machine. [`entry`] holds the plain-data types that cross the
//! facade boundary.

pub mod entry;
pub mod windows_ops;

#[cfg(target_os = "windows")]
pub mod windows;

/// True when the current process holds an elevated (administrator)
/// token. `all-users` installs require this; the Options step disables
/// that scope when it returns false.
pub fn is_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows::elevation::is_elevated()
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::debug!("is_elevated: non-Windows, reporting false");
        false
    }
}
