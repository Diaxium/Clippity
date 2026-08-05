//! Put *files* on the Windows clipboard, as `CF_HDROP`.
//!
//! Distinct from everything `arboard` does for us elsewhere. `arboard`
//! copies **content** — an image's pixels, a string's bytes — which is
//! right for a screenshot and wrong for a recording: a two-minute MP4 is
//! tens of megabytes, nothing renders it from a raw byte blob, and the
//! apps a user actually wants to paste a clip into (Explorer, Discord,
//! Slack, Teams, an email compose window) all read `CF_HDROP` and attach
//! the file by path. So this copies a **reference**: the clipboard holds
//! the same thing a drag out of Explorer would put there, at constant
//! cost regardless of how long the recording is.
//!
//! The consequence worth knowing: the clipboard names a path, so moving
//! or deleting the file invalidates the paste. That is the same contract
//! Explorer's own Copy has, and it is why the recorder only ever calls
//! this *after* the working file has been promoted to its final name —
//! a `CF_HDROP` pointing at `.clippity-recording-1234.mp4` would go
//! stale the instant the session finished.
//!
//! The buffer layout is a pure function ([`hdrop_payload`]) so the part
//! that is easy to get wrong — the `DROPFILES` header offset, wide
//! encoding, and the double-NUL terminator — is unit-tested on any
//! platform, leaving [`copy_files_to_clipboard`] as a thin Win32 shell.

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_HDROP;
use windows::Win32::UI::Shell::DROPFILES;

/// Byte size of the `DROPFILES` header every `CF_HDROP` block starts
/// with. The file list follows immediately after it, which is exactly
/// what the header's `pFiles` field has to say.
const DROPFILES_LEN: usize = std::mem::size_of::<DROPFILES>();

/// Build the `CF_HDROP` global-memory block for `paths`.
///
/// Layout, in order:
///   1. a `DROPFILES` header whose `pFiles` points just past itself and
///      whose `fWide` is set, because we always write UTF-16;
///   2. each path as a NUL-terminated UTF-16 string, back to back;
///   3. one extra NUL, terminating the *list*.
///
/// That trailing NUL is the whole reason this is a function and not an
/// inline `extend`: a list terminated only by its last string's NUL
/// parses as valid right up until the receiving app reads one element
/// past the end, which fails as a garbage filename in someone else's
/// process rather than as an error here.
///
/// Returns `None` for an empty list — there is no such thing as a
/// zero-file drop, and an empty `CF_HDROP` would replace whatever the
/// user had on their clipboard with nothing.
pub fn hdrop_payload<P: AsRef<Path>>(paths: &[P]) -> Option<Vec<u8>> {
    if paths.is_empty() {
        return None;
    }

    let mut list: Vec<u16> = Vec::new();
    for path in paths {
        let wide = path.as_ref().as_os_str().encode_wide();
        let before = list.len();
        list.extend(wide);
        // A path containing an interior NUL would silently truncate for
        // every consumer of the block. It cannot come from the recorder
        // (we build those names ourselves), so this is a guard against a
        // future caller rather than an expected case — but a corrupt
        // clipboard is a bad way to find out.
        if list[before..].contains(&0) {
            return None;
        }
        list.push(0);
    }
    // Terminates the list, not the last path.
    list.push(0);

    let mut bytes = vec![0u8; DROPFILES_LEN];
    let header = DROPFILES {
        pFiles: DROPFILES_LEN as u32,
        pt: Default::default(),
        fNC: false.into(),
        fWide: true.into(),
    };
    // SAFETY: `DROPFILES` is a plain `#[repr(C)]` POD with no padding
    // invariants and no pointers, and `bytes` was sized from the same
    // `size_of`, so the copy is in bounds.
    unsafe {
        std::ptr::copy_nonoverlapping(
            &header as *const DROPFILES as *const u8,
            bytes.as_mut_ptr(),
            DROPFILES_LEN,
        );
    }
    for unit in list {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    Some(bytes)
}

/// Replace the clipboard's contents with a file-drop list naming
/// `paths`.
///
/// Best-effort by design at the call site, but loud here: every failure
/// path returns a message rather than being swallowed, so the caller can
/// decide whether losing the clipboard copy is worth telling the user
/// about. For the recorder it is not — the recording is the product and
/// the clipboard is a convenience — so it logs and moves on.
pub fn copy_files_to_clipboard<P: AsRef<Path>>(paths: &[P]) -> Result<(), String> {
    let payload = hdrop_payload(paths).ok_or("no usable file paths for the clipboard")?;

    unsafe {
        // A moveable block, because ownership passes to the clipboard on
        // a successful `SetClipboardData` and the system frees it with
        // `GlobalFree` later.
        let hglobal: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, payload.len())
            .map_err(|e| format!("clipboard alloc: {e}"))?;

        let locked = GlobalLock(hglobal);
        if locked.is_null() {
            let _ = GlobalFree(Some(hglobal));
            return Err("clipboard alloc could not be locked".into());
        }
        std::ptr::copy_nonoverlapping(payload.as_ptr(), locked as *mut u8, payload.len());
        let _ = GlobalUnlock(hglobal);

        // Opened as late as possible: between `OpenClipboard` and
        // `CloseClipboard` no other process can touch the clipboard, so
        // the allocation and the copy above deliberately happen outside
        // the window.
        if OpenClipboard(Some(HWND::default())).is_err() {
            let _ = GlobalFree(Some(hglobal));
            return Err("another application is holding the clipboard".into());
        }

        let result = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| format!("clipboard clear: {e}"))?;
            SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(hglobal.0)))
                .map_err(|e| format!("clipboard set: {e}"))?;
            Ok(())
        })();

        let _ = CloseClipboard();
        if result.is_err() {
            // Ownership only transfers on success, so a failed set
            // leaves the block ours to release.
            let _ = GlobalFree(Some(hglobal));
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Read the UTF-16 list back out of a payload, minus the header.
    fn units(bytes: &[u8]) -> Vec<u16> {
        bytes[DROPFILES_LEN..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    }

    #[test]
    fn a_single_path_is_nul_terminated_twice() {
        let payload = hdrop_payload(&[Path::new("C:\\a.mp4")]).expect("payload");
        let list = units(&payload);
        let expected: Vec<u16> = "C:\\a.mp4".encode_utf16().chain([0, 0]).collect();
        assert_eq!(list, expected);
    }

    #[test]
    fn several_paths_are_packed_back_to_back() {
        let payload = hdrop_payload(&[Path::new("a"), Path::new("b")]).expect("payload");
        assert_eq!(units(&payload), vec![b'a' as u16, 0, b'b' as u16, 0, 0]);
    }

    #[test]
    fn the_header_points_at_the_first_path() {
        let payload = hdrop_payload(&[Path::new("a")]).expect("payload");
        // `pFiles` is the first field of `DROPFILES`, so the first four
        // bytes are the offset the list starts at.
        let p_files = u32::from_le_bytes(payload[0..4].try_into().unwrap());
        assert_eq!(p_files as usize, DROPFILES_LEN);
        // "a", its NUL, and the list's NUL — three UTF-16 units.
        assert_eq!(payload.len(), DROPFILES_LEN + 3 * 2);
    }

    #[test]
    fn an_empty_list_produces_nothing() {
        // Rather than an empty drop, which would clear the user's
        // clipboard for no reason.
        assert!(hdrop_payload::<&Path>(&[]).is_none());
    }

    #[test]
    fn non_ascii_paths_survive_as_utf16() {
        let payload = hdrop_payload(&[Path::new("C:\\café\\clip.mp4")]).expect("payload");
        let list = units(&payload);
        let expected: Vec<u16> = "C:\\café\\clip.mp4".encode_utf16().chain([0, 0]).collect();
        assert_eq!(list, expected);
    }
}
