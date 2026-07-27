//! Windows **Restart Manager** — enumerate the processes locking a file a
//! maintenance operation must change, and (as a controlled fallback)
//! terminate a Clippity-owned one.
//!
//! Restart Manager is the mechanism Microsoft documents for installers and
//! updaters that need to know which processes hold a file open, instead of
//! guessing or blindly force-closing everything. The flow is fixed:
//! `RmStartSession` → `RmRegisterResources` (the files we care about) →
//! `RmGetList` (who holds them) → `RmEndSession`. For each reported process
//! we resolve its image path (`QueryFullProcessImageNameW`) so the pure
//! classifier in `installer_domain::shutdown` can decide whether it is ours
//! to stop or an unrelated app the user must close.
//!
//! Nothing here decides *policy*; it only gathers facts and executes an
//! explicit termination the services layer already vetted against the
//! domain plan.

use std::path::Path;

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_MORE_DATA, ERROR_SUCCESS, HANDLE};
use windows::Win32::System::RestartManager::{
    RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
    RM_PROCESS_INFO,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

use installer_domain::shutdown::{LockingProcess, RmAppKind};
use installer_infra::error::{other, InstallerResult};

/// Cap the RmGetList grow-and-retry loop so a rapidly changing lock set can
/// never spin forever.
const MAX_GETLIST_TRIES: usize = 5;

/// A Restart Manager session that is always ended, even on an early return.
struct RmSession(u32);

impl Drop for RmSession {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a handle a successful `RmStartSession` returned.
        unsafe {
            let _ = RmEndSession(self.0);
        }
    }
}

/// Enumerate the processes currently holding any of `paths` open.
///
/// Returns an empty vector when nothing locks them (the common, healthy
/// case). Registration of a path that does not exist is harmless — Restart
/// Manager simply reports no holders for it.
pub fn enumerate_lockers(paths: &[&Path]) -> InstallerResult<Vec<LockingProcess>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    // Start a session. The session-key buffer must be CCH_RM_SESSION_KEY + 1
    // wide chars; the value itself is only needed to *join* a session, which
    // we never do.
    let mut handle: u32 = 0;
    let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    // SAFETY: `handle` and `key` are live for the call; a null session-flags
    // is the documented default.
    let rc = unsafe { RmStartSession(&mut handle, None, PWSTR(key.as_mut_ptr())) };
    if rc != ERROR_SUCCESS {
        return Err(other(format!("RmStartSession failed (WIN32_ERROR {})", rc.0)));
    }
    let session = RmSession(handle);

    // Register the files whose holders we want. Own the HSTRINGs so their
    // buffers outlive the PCWSTR slice pointing into them.
    let wide: Vec<HSTRING> = paths.iter().map(|p| HSTRING::from(p.as_os_str())).collect();
    let names: Vec<PCWSTR> = wide.iter().map(|h| PCWSTR(h.as_ptr())).collect();
    // SAFETY: `names` and the HSTRINGs it points at outlive the call.
    let rc = unsafe { RmRegisterResources(session.0, Some(&names), None, None) };
    if rc != ERROR_SUCCESS {
        return Err(other(format!(
            "RmRegisterResources failed (WIN32_ERROR {})",
            rc.0
        )));
    }

    let infos = get_list(session.0)?;
    let self_pid = unsafe { GetCurrentProcessId() };

    let lockers = infos
        .iter()
        .map(|info| {
            let pid = info.Process.dwProcessId;
            LockingProcess {
                pid,
                app_name: wide_to_string(&info.strAppName),
                exe_path: resolve_exe_path(pid),
                kind: RmAppKind::from_raw(info.ApplicationType.0),
                is_self: pid == self_pid,
            }
        })
        .collect();

    // `session` drops here, ending the Restart Manager session.
    Ok(lockers)
}

/// Call `RmGetList`, growing the buffer until it fits (the affected set can
/// change between the size query and the fetch).
fn get_list(handle: u32) -> InstallerResult<Vec<RM_PROCESS_INFO>> {
    let mut needed: u32 = 0;
    let mut have: u32 = 0;
    let mut reasons: u32 = 0;

    // First call with a zero-length buffer learns how many entries exist.
    // SAFETY: all out-pointers are live; a null array with have=0 is the
    // documented size-probe form.
    let rc = unsafe { RmGetList(handle, &mut needed, &mut have, None, &mut reasons) };
    if rc != ERROR_SUCCESS && rc != ERROR_MORE_DATA {
        return Err(other(format!("RmGetList (probe) failed (WIN32_ERROR {})", rc.0)));
    }
    if needed == 0 {
        return Ok(Vec::new());
    }

    for _ in 0..MAX_GETLIST_TRIES {
        let mut buf = vec![RM_PROCESS_INFO::default(); needed as usize];
        have = needed;
        // SAFETY: `buf` holds `have` default-initialised entries; RmGetList
        // fills up to `have` and writes the true count back into `have`.
        let rc = unsafe {
            RmGetList(
                handle,
                &mut needed,
                &mut have,
                Some(buf.as_mut_ptr()),
                &mut reasons,
            )
        };
        match rc {
            e if e == ERROR_SUCCESS => {
                buf.truncate(have as usize);
                return Ok(buf);
            }
            // The set grew between calls — `needed` now holds the new size.
            e if e == ERROR_MORE_DATA => continue,
            e => return Err(other(format!("RmGetList failed (WIN32_ERROR {})", e.0))),
        }
    }
    Err(other("RmGetList did not converge on a stable process list"))
}

/// Resolve a process's full image path, or `None` when it cannot be opened
/// (e.g. a more-privileged process while we run unelevated). A `None` path
/// is expected and handled by the classifier's name/kind fallback.
fn resolve_exe_path(pid: u32) -> Option<String> {
    // SAFETY: OpenProcess returns a handle we close below; a failed open is
    // an Err we map to None.
    let handle: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;

    let mut buf = [0u16; 1024];
    let mut size = buf.len() as u32;
    // SAFETY: `handle` is valid; `buf`/`size` describe a live buffer;
    // on success `size` is set to the character count written.
    let result = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size)
    };
    // SAFETY: closing the handle we opened; ignore the (best-effort) result.
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.ok()?;
    Some(String::from_utf16_lossy(&buf[..size as usize]))
}

/// Force-terminate a process by pid. The services layer calls this **only**
/// for a process the domain plan classified as Clippity-owned and not our
/// own image — never an unrelated or system-critical one.
pub fn terminate(pid: u32) -> InstallerResult<()> {
    // SAFETY: open with terminate rights; a failed open is a mapped error.
    let handle: HANDLE = unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }
        .map_err(|e| other(format!("could not open Clippity process {pid} to stop it: {e}")))?;
    // SAFETY: `handle` has PROCESS_TERMINATE; exit code 1 marks a forced stop.
    let result = unsafe { TerminateProcess(handle, 1) };
    // SAFETY: closing the handle we opened.
    unsafe {
        let _ = CloseHandle(handle);
    }
    result.map_err(|e| other(format!("could not stop Clippity process {pid}: {e}")))
}

/// Convert a fixed-size wide array (Restart Manager's `strAppName`) to a
/// `String`, stopping at the first NUL.
fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}
