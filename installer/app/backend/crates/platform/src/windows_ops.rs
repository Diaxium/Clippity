//! Cross-platform facade over the Win32 installer operations.
//!
//! Every function here is callable on any target: on Windows it forwards
//! to the real `windows::*` implementation, elsewhere it logs and returns
//! a benign value. This lets `installer-services` orchestrate an install
//! without a single `cfg` of its own.

use std::path::{Path, PathBuf};

use installer_domain::shutdown::LockingProcess;
use installer_domain::state::RegistryHive;
use installer_infra::error::InstallerResult;

pub use crate::entry::UninstallEntry;

/// Create a desktop shortcut named `link_name` pointing at `target_exe`.
/// Returns the `.lnk` path so the services layer can record it.
pub fn create_desktop_shortcut(
    target_exe: &str,
    link_name: &str,
    all_users: bool,
) -> InstallerResult<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::shortcuts::create_desktop_shortcut(target_exe, link_name, all_users)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (target_exe, all_users);
        tracing::info!(name = link_name, "create_desktop_shortcut (noop)");
        Ok(PathBuf::from(format!("{link_name}.lnk")))
    }
}

/// Create a Start-menu shortcut named `link_name` pointing at `target_exe`.
pub fn create_start_menu_shortcut(
    target_exe: &str,
    link_name: &str,
    all_users: bool,
) -> InstallerResult<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::shortcuts::create_start_menu_shortcut(target_exe, link_name, all_users)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (target_exe, all_users);
        tracing::info!(name = link_name, "create_start_menu_shortcut (noop)");
        Ok(PathBuf::from(format!("{link_name}.lnk")))
    }
}

/// Re-create a `.lnk` at an exact recorded path (manifest-driven repair).
pub fn create_shortcut_at(
    link_path: &Path,
    target_exe: &str,
    link_name: &str,
) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::shortcuts::create_shortcut_at(link_path, target_exe, link_name)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (target_exe, link_name);
        tracing::info!(path = %link_path.display(), "create_shortcut_at (noop)");
        Ok(())
    }
}

/// Delete a specific `.lnk` by absolute path (manifest-driven uninstall).
pub fn remove_shortcut_path(link_path: &Path) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::shortcuts::remove_shortcut_path(link_path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::info!(path = %link_path.display(), "remove_shortcut_path (noop)");
        Ok(())
    }
}

/// Remove a desktop shortcut by name, both scopes (best-effort fallback).
pub fn remove_desktop_shortcut(link_name: &str) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::shortcuts::remove_desktop_shortcut(link_name)
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::info!(name = link_name, "remove_desktop_shortcut (noop)");
        Ok(())
    }
}

/// Enable or disable launching `target_exe` at user login.
pub fn set_start_at_login(target_exe: &str, enabled: bool) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::registry::set_start_at_login(target_exe, enabled)
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::info!(target = target_exe, enabled, "set_start_at_login (noop)");
        Ok(())
    }
}

/// Write (or update) the Add/Remove Programs entry.
pub fn write_uninstall_entry(entry: &UninstallEntry) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::registry::write_uninstall_entry(entry)
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::info!(name = %entry.display_name, "write_uninstall_entry (noop)");
        Ok(())
    }
}

/// Delete the Add/Remove Programs entry during uninstall.
pub fn remove_uninstall_entry(hive: RegistryHive) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::registry::remove_uninstall_entry(hive)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hive;
        tracing::info!("remove_uninstall_entry (noop)");
        Ok(())
    }
}

/// Which hive, if any, carries an `Uninstall\Clippity` key.
pub fn uninstall_hive_present() -> Option<RegistryHive> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::registry::uninstall_hive_present()
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

/// Whether the entry under `hive` carries our ownership marker.
pub fn uninstall_entry_is_managed(hive: RegistryHive) -> bool {
    #[cfg(target_os = "windows")]
    {
        crate::windows::registry::uninstall_entry_is_managed(hive)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = hive;
        false
    }
}

/// Schedule a Clippity-owned file or empty directory for deletion at the
/// next reboot — the last-resort fallback when it is still locked after a
/// graceful shutdown. Returns `Ok(())` on Windows; a logged no-op (so no
/// false reboot claim) elsewhere.
pub fn schedule_delete_on_reboot(path: &Path) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::reboot::schedule_delete_on_reboot(path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::info!(path = %path.display(), "schedule_delete_on_reboot (noop)");
        Ok(())
    }
}

/// Enumerate the processes currently holding any of `paths` open, via
/// Windows Restart Manager. Off-Windows this is a logged empty result, so
/// the services layer's lock-clearing is a safe no-op there.
pub fn enumerate_lockers(paths: &[&Path]) -> InstallerResult<Vec<LockingProcess>> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::restart_manager::enumerate_lockers(paths)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = paths;
        Ok(Vec::new())
    }
}

/// Force-terminate a process by pid. Callers must only pass a pid the domain
/// [`ShutdownPlan`](installer_domain::shutdown::ShutdownPlan) marked
/// Clippity-owned and terminable — never an unrelated or system process.
pub fn terminate_process(pid: u32) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::restart_manager::terminate(pid)
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::info!(pid, "terminate_process (noop)");
        Ok(())
    }
}

/// Start a second copy of `exe` with an elevated token, passing `args`.
///
/// The caller is expected to close the current (unelevated) window once
/// this returns `Ok` — the two processes must not both drive an install.
pub fn relaunch_elevated(exe: &Path, args: &str) -> InstallerResult<()> {
    #[cfg(target_os = "windows")]
    {
        crate::windows::relaunch::relaunch_elevated(exe, args)
    }
    #[cfg(not(target_os = "windows"))]
    {
        tracing::info!(exe = %exe.display(), args, "relaunch_elevated (noop)");
        Ok(())
    }
}
