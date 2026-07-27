//! Locked-file fallback: schedule a delete for the next reboot.
//!
//! When a Clippity-owned file cannot be removed because it is still in use
//! — most importantly the maintenance/uninstaller executable removing its
//! own directory — the last-resort correct move is
//! `MoveFileExW(MOVEFILE_DELAY_UNTIL_REBOOT)`, which the OS honors during
//! the next boot. Directories scheduled this way are removed only when
//! empty, so children must be scheduled before their parent. Using the
//! documented API is deliberately preferred over editing
//! `PendingFileRenameOperations` by hand.

use std::path::Path;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};

use installer_infra::error::{other, InstallerResult};

/// Schedule `path` (a file, or an already-empty directory) for deletion at
/// the next reboot. Passing a null destination is the documented "delete"
/// form of `MoveFileExW`.
pub fn schedule_delete_on_reboot(path: &Path) -> InstallerResult<()> {
    let existing = HSTRING::from(path.as_os_str());
    // SAFETY: `existing` outlives the call; a null new-name is the
    // documented delete-on-reboot form.
    unsafe { MoveFileExW(PCWSTR(existing.as_ptr()), PCWSTR::null(), MOVEFILE_DELAY_UNTIL_REBOOT) }
        .map_err(|e| {
            other(format!(
                "MoveFileExW(delay-until-reboot) for {} failed: {e}",
                path.display()
            ))
        })
}
