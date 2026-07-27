//! Desktop / Start-menu shortcuts, created and removed through the
//! `IShellLinkW` + `IPersistFile` COM pair.
//!
//! Every `.lnk` this module writes is returned as an absolute path so the
//! services layer can record it in the installation manifest; uninstall
//! then deletes exactly those recorded paths rather than guessing. The
//! run-at-login registration is a registry value and lives in
//! `registry.rs`.

use std::path::{Path, PathBuf};

use windows::core::{Interface, GUID, HSTRING, PWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    FOLDERID_CommonPrograms, FOLDERID_Desktop, FOLDERID_Programs, FOLDERID_PublicDesktop,
    IShellLinkW, SHGetKnownFolderPath, ShellLink, KNOWN_FOLDER_FLAG,
};

use installer_infra::error::{other, InstallerResult};

/// Resolve a known folder to a path, freeing the COM-allocated buffer.
fn known_folder(id: &GUID) -> InstallerResult<PathBuf> {
    // SAFETY: `id` is a static GUID; the returned PWSTR is freed below.
    unsafe {
        let pw: PWSTR = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None)
            .map_err(|e| other(format!("SHGetKnownFolderPath failed: {e}")))?;
        let s = pw.to_string().map_err(|e| other(format!("known folder path unreadable: {e}")))?;
        CoTaskMemFree(Some(pw.0 as *const _));
        Ok(PathBuf::from(s))
    }
}

/// The current user's (or, for all-users, the common) Desktop directory.
pub fn desktop_dir(all_users: bool) -> InstallerResult<PathBuf> {
    known_folder(if all_users { &FOLDERID_PublicDesktop } else { &FOLDERID_Desktop })
}

/// The current user's (or common) Start-menu Programs directory.
pub fn programs_dir(all_users: bool) -> InstallerResult<PathBuf> {
    known_folder(if all_users { &FOLDERID_CommonPrograms } else { &FOLDERID_Programs })
}

/// Write a `.lnk` at `link_path` pointing at `target_exe`.
///
/// Initialises COM on this thread (install runs on a worker thread that
/// has none), creates a `ShellLink`, sets the path/description/icon, and
/// persists it via `IPersistFile::Save`.
fn write_lnk(link_path: &Path, target_exe: &str, description: &str) -> InstallerResult<()> {
    // SAFETY: standard COM shortcut-creation sequence; every interface is
    // released by RAII (`Drop`) and the string arguments outlive the calls.
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // Pair CoUninitialize only when we actually initialised (S_OK).
        let should_uninit = hr.is_ok();

        let result = (|| -> InstallerResult<()> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| other(format!("CoCreateInstance(ShellLink) failed: {e}")))?;
            link.SetPath(&HSTRING::from(target_exe))
                .map_err(|e| other(format!("IShellLink::SetPath failed: {e}")))?;
            link.SetDescription(&HSTRING::from(description))
                .map_err(|e| other(format!("IShellLink::SetDescription failed: {e}")))?;
            // First icon of the target exe.
            let _ = link.SetIconLocation(&HSTRING::from(target_exe), 0);
            // Point the working directory at the install folder.
            if let Some(parent) = Path::new(target_exe).parent() {
                let _ = link.SetWorkingDirectory(&HSTRING::from(parent.as_os_str()));
            }

            let persist: IPersistFile = link
                .cast()
                .map_err(|e| other(format!("QueryInterface(IPersistFile) failed: {e}")))?;
            persist
                .Save(&HSTRING::from(link_path.as_os_str()), true)
                .map_err(|e| other(format!("IPersistFile::Save({}) failed: {e}", link_path.display())))?;
            Ok(())
        })();

        if should_uninit {
            CoUninitialize();
        }
        result
    }
}

/// Create a desktop shortcut named `link_name`; returns the `.lnk` path.
pub fn create_desktop_shortcut(
    target_exe: &str,
    link_name: &str,
    all_users: bool,
) -> InstallerResult<PathBuf> {
    let dir = desktop_dir(all_users)?;
    std::fs::create_dir_all(&dir).ok();
    let path = dir.join(format!("{link_name}.lnk"));
    tracing::info!(target = target_exe, path = %path.display(), "creating desktop shortcut");
    write_lnk(&path, target_exe, link_name)?;
    Ok(path)
}

/// Create a Start-menu shortcut named `link_name`; returns the `.lnk` path.
pub fn create_start_menu_shortcut(
    target_exe: &str,
    link_name: &str,
    all_users: bool,
) -> InstallerResult<PathBuf> {
    let dir = programs_dir(all_users)?;
    std::fs::create_dir_all(&dir).ok();
    let path = dir.join(format!("{link_name}.lnk"));
    tracing::info!(target = target_exe, path = %path.display(), "creating start-menu shortcut");
    write_lnk(&path, target_exe, link_name)?;
    Ok(path)
}

/// Re-create a `.lnk` at an exact absolute path pointing at `target_exe` —
/// the precise inverse of a recorded [`ShortcutRecord`], used by repair to
/// restore a shortcut the manifest owns without recomputing which folder it
/// belonged in. `link_name` is the shortcut's description text.
pub fn create_shortcut_at(
    link_path: &Path,
    target_exe: &str,
    link_name: &str,
) -> InstallerResult<()> {
    if let Some(parent) = link_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    tracing::info!(target = target_exe, path = %link_path.display(), "restoring shortcut");
    write_lnk(link_path, target_exe, link_name)
}

/// Delete a specific `.lnk` by absolute path; a missing file is success.
pub fn remove_shortcut_path(link_path: &Path) -> InstallerResult<()> {
    if link_path.exists() {
        tracing::info!(path = %link_path.display(), "removing shortcut");
        std::fs::remove_file(link_path)?;
    }
    Ok(())
}

/// Remove the desktop shortcut named `link_name` (both scopes), for the
/// common case where no manifest path is available.
pub fn remove_desktop_shortcut(link_name: &str) -> InstallerResult<()> {
    for all_users in [false, true] {
        if let Ok(dir) = desktop_dir(all_users) {
            let _ = remove_shortcut_path(&dir.join(format!("{link_name}.lnk")));
        }
    }
    Ok(())
}
