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
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
use windows::Win32::UI::Shell::{
    ShellExecuteExW, ShellExecuteW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
};
use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_NORMAL};

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

/// Run an executable under UAC and wait for its process exit code.
///
/// Update uses this instead of the fire-and-forget relaunch above: the old
/// maintenance process may only report success after the newly downloaded,
/// verified setup has actually committed its embedded payload.
pub fn run_elevated_and_wait(exe: &Path, args: &str, hidden: bool) -> InstallerResult<i32> {
    let file = HSTRING::from(exe.as_os_str());
    let params = HSTRING::from(args);
    let verb = HSTRING::from("runas");
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: if hidden { SW_HIDE.0 } else { SW_NORMAL.0 },
        ..Default::default()
    };

    tracing::info!(exe = %exe.display(), args, "starting elevated update worker");
    // SAFETY: all strings and the mutable structure live until the call
    // returns. SEE_MASK_NOCLOSEPROCESS guarantees hProcess on success.
    unsafe { ShellExecuteExW(&mut info) }.map_err(|e| {
        if e.code().0 == 5 {
            InstallerError::ElevationRequired
        } else {
            other(format!("could not start elevated update worker: {e}"))
        }
    })?;

    if info.hProcess.is_invalid() {
        return Err(other("elevated update worker returned no process handle"));
    }
    // SAFETY: hProcess is owned by this function and remains valid through
    // the wait and exit-code read. CloseHandle releases it on every result.
    unsafe { WaitForSingleObject(info.hProcess, INFINITE) };
    let mut code = 0u32;
    let result = unsafe { GetExitCodeProcess(info.hProcess, &mut code) }
        .map(|_| code as i32)
        .map_err(|e| other(format!("could not read update worker exit code: {e}")));
    let _ = unsafe { CloseHandle(info.hProcess) };
    result
}
