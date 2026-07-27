//! Relaunching the installer with an elevated token.
//!
//! The wizard deliberately starts unelevated: a per-user install into a
//! writable folder never needs administrator rights, and asking for them
//! up front would put a UAC prompt in front of every user regardless.
//! Elevation is requested only once the destination is known to require
//! it — see `installer_domain::install::needs_elevation`.
//!
//! Windows has no way to add privileges to a running process, so the only
//! route is to start a second copy under the `runas` verb and let the
//! first exit. The chosen plan travels to that copy through a handoff
//! file, so the user does not re-answer the wizard after approving UAC.

use std::path::Path;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_NORMAL;

use installer_infra::error::{other, InstallerError, InstallerResult};

/// `ShellExecuteW` returns a value >32 on success; at or below that it is
/// an error code. `SE_ERR_ACCESSDENIED` (5) is the one users actually hit
/// — it means they dismissed the UAC prompt.
const SE_ERR_ACCESSDENIED: isize = 5;

/// Relaunch `exe` elevated, passing `args` on the command line.
///
/// Returns `ElevationRequired` when the user declines the UAC prompt, so
/// the caller can leave the wizard exactly where it was instead of
/// treating a deliberate "No" as a crash.
pub fn relaunch_elevated(exe: &Path, args: &str) -> InstallerResult<()> {
    let file = HSTRING::from(exe.as_os_str());
    let params = HSTRING::from(args);
    let verb = HSTRING::from("runas");

    tracing::info!(exe = %exe.display(), args, "requesting elevation");

    // SAFETY: every pointer is a live HSTRING that outlives the call, and
    // a null HWND/directory is documented as "no owner window, inherit
    // the current directory".
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR(params.as_ptr()),
            PCWSTR::null(),
            SW_NORMAL,
        )
    };

    let code = result.0 as isize;
    if code > 32 {
        tracing::info!("elevated instance started");
        return Ok(());
    }

    if code == SE_ERR_ACCESSDENIED {
        tracing::info!("user declined the elevation prompt");
        return Err(InstallerError::ElevationRequired);
    }

    Err(other(format!(
        "could not restart the installer with administrator rights (code {code})"
    )))
}
