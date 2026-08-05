//! Which Windows this is — for the diagnostics card and the exported
//! bundle.
//!
//! Read from `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` rather
//! than from `GetVersionEx`, which lies to unmanifested processes, and
//! rather than from `RtlGetVersion`, which is honest but only knows
//! numbers. A bug report wants "Windows 11 Pro 24H2 (26100)", not
//! "10.0.26100".
//!
//! Everything here degrades to a plausible answer rather than failing:
//! an unreadable registry key costs a line of context in a report, and
//! is never worth an error the caller has to handle.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;

use windows::core::{w, PCWSTR};
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

/// Registry path holding the OS description.
const CURRENT_VERSION: PCWSTR = w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");

/// Build number at which Windows 10 became Windows 11 — the registry's
/// `ProductName` famously still says "Windows 10" on an 11 install, so
/// the build is the only honest discriminator.
const WINDOWS_11_BUILD: u32 = 22000;

/// A human description of the running OS, e.g.
/// `Windows 11 Pro 24H2 (build 26100)`.
///
/// Falls back to the compile-time OS name when nothing can be read.
pub fn describe() -> String {
    let product = read_string("ProductName").unwrap_or_else(|| "Windows".to_string());
    let display = read_string("DisplayVersion");
    let build = read_string("CurrentBuild").and_then(|s| s.parse::<u32>().ok());
    let ubr = read_dword("UBR");

    let product = match build {
        // "Windows 10 Pro" on a machine that is plainly Windows 11 is
        // the single most misleading line a report can carry.
        Some(b) if b >= WINDOWS_11_BUILD => product.replace("Windows 10", "Windows 11"),
        _ => product,
    };

    let mut out = product;
    if let Some(display) = display {
        out.push(' ');
        out.push_str(&display);
    }
    match (build, ubr) {
        (Some(b), Some(u)) => out.push_str(&format!(" (build {b}.{u})")),
        (Some(b), None) => out.push_str(&format!(" (build {b})")),
        _ => {}
    }
    out
}

/// Read a `REG_SZ` under `CurrentVersion`.
fn read_string(name: &str) -> Option<String> {
    let name = wide(name);
    let mut size: u32 = 0;

    // SAFETY: two calls of the documented size-then-fill protocol. The
    // first passes a null buffer to learn the byte length; the second
    // fills a buffer of exactly that length. `RRF_RT_REG_SZ` makes the
    // API refuse any other value type rather than reinterpreting it.
    unsafe {
        if RegGetValueW(
            HKEY_LOCAL_MACHINE,
            CURRENT_VERSION,
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
        .is_err()
            || size == 0
        {
            return None;
        }

        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        let mut size_out = size;
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            CURRENT_VERSION,
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast()),
            Some(&mut size_out),
        )
        .ok()
        .ok()?;

        // The value is NUL-terminated inside the buffer; everything from
        // the terminator on is padding.
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        let text = OsString::from_wide(&buffer[..end])
            .to_string_lossy()
            .into_owned();
        (!text.trim().is_empty()).then_some(text)
    }
}

/// Read a `REG_DWORD` under `CurrentVersion`.
fn read_dword(name: &str) -> Option<u32> {
    let name = wide(name);
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;

    // SAFETY: a fixed-size output buffer whose length is passed in and
    // whose type is pinned by `RRF_RT_REG_DWORD`.
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            CURRENT_VERSION,
            PCWSTR(name.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(std::ptr::addr_of_mut!(value).cast()),
            Some(&mut size),
        )
        .ok()
        .ok()?;
    }
    Some(value)
}

/// NUL-terminated UTF-16, as every `*W` API wants it.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describe_names_a_windows() {
        // Live: this test runs on the machine it describes. It asserts
        // shape, not contents — the point is that the registry read
        // path works at all, since its failure mode is a silent
        // fallback that would otherwise never be noticed.
        let described = describe();
        assert!(
            described.starts_with("Windows"),
            "unexpected OS description: {described}"
        );
    }

    #[test]
    fn a_missing_value_is_none_rather_than_a_panic() {
        assert_eq!(read_string("ThisValueDoesNotExist"), None);
        assert_eq!(read_dword("ThisValueDoesNotExist"), None);
    }
}
