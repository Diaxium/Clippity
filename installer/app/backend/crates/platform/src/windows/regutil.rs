//! Thin, safe-ish wrappers over the handful of Win32 registry calls the
//! installer needs.
//!
//! Centralising the UTF-16 encoding, the `HKEY` lifetime, and the
//! WIN32_ERROR-to-`InstallerResult` mapping keeps every caller readable
//! and keeps the `unsafe` blocks in one audited place. Missing values and
//! keys are treated as already-gone (idempotent delete), which is what an
//! uninstall re-run needs.

use std::iter::once;

use windows::core::PCWSTR;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegDeleteValueW, RegGetValueW, RegOpenKeyExW,
    RegSetValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE, REG_DWORD,
    REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_ANY,
};

use installer_domain::state::RegistryHive;
use installer_infra::error::{other, InstallerResult};

/// `ERROR_FILE_NOT_FOUND` — "no such key/value", which we treat as success
/// when deleting or probing.
const ERROR_FILE_NOT_FOUND: u32 = 2;
/// `ERROR_MORE_DATA` — a probe found the value but our buffer was null.
const ERROR_MORE_DATA: u32 = 234;

/// The root `HKEY` for a hive.
fn root(hive: RegistryHive) -> HKEY {
    match hive {
        RegistryHive::CurrentUser => HKEY_CURRENT_USER,
        RegistryHive::LocalMachine => HKEY_LOCAL_MACHINE,
    }
}

/// UTF-16, null-terminated, as the wide Win32 string APIs expect.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(once(0)).collect()
}

/// An open registry key that closes itself on drop.
pub struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // A failed close only leaks a handle for the (short) installer
        // process lifetime, so best-effort is fine.
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

/// Open-or-create `subkey` under `hive` for writing.
pub fn create(hive: RegistryHive, subkey: &str) -> InstallerResult<Key> {
    let sub = wide(subkey);
    let mut hkey = HKEY::default();
    let rc = unsafe {
        RegCreateKeyExW(
            root(hive),
            PCWSTR(sub.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut hkey,
            None,
        )
    };
    rc.ok()
        .map_err(|e| other(format!("RegCreateKeyExW({subkey}) failed: {e}")))?;
    Ok(Key(hkey))
}

/// Open `subkey` under `hive` for reading; `None` if it does not exist.
pub fn open_read(hive: RegistryHive, subkey: &str) -> Option<Key> {
    let sub = wide(subkey);
    let mut hkey = HKEY::default();
    let rc = unsafe { RegOpenKeyExW(root(hive), PCWSTR(sub.as_ptr()), None, KEY_READ, &mut hkey) };
    rc.is_ok().then_some(Key(hkey))
}

/// Set a `REG_SZ` value on an open key.
pub fn set_sz(key: &Key, name: &str, value: &str) -> InstallerResult<()> {
    let n = wide(name);
    let data = wide(value);
    // SAFETY: `data` is a live Vec<u16>; reinterpreting it as its byte
    // view for the duration of the call is sound and does not outlive it.
    let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2) };
    unsafe { RegSetValueExW(key.0, PCWSTR(n.as_ptr()), None, REG_SZ, Some(bytes)) }
        .ok()
        .map_err(|e| other(format!("RegSetValueExW({name}) failed: {e}")))
}

/// Set a `REG_DWORD` value on an open key.
pub fn set_dword(key: &Key, name: &str, value: u32) -> InstallerResult<()> {
    let n = wide(name);
    let bytes = value.to_le_bytes();
    unsafe { RegSetValueExW(key.0, PCWSTR(n.as_ptr()), None, REG_DWORD, Some(&bytes)) }
        .ok()
        .map_err(|e| other(format!("RegSetValueExW({name}) failed: {e}")))
}

/// Delete a value; a missing value is treated as already-gone.
pub fn delete_value(key: &Key, name: &str) -> InstallerResult<()> {
    let n = wide(name);
    let rc = unsafe { RegDeleteValueW(key.0, PCWSTR(n.as_ptr())) };
    if rc.is_ok() || rc.0 == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(other(format!("RegDeleteValueW({name}) failed: {rc:?}")))
    }
}

/// Delete `subkey` and everything under it; a missing key is success.
pub fn delete_tree(hive: RegistryHive, subkey: &str) -> InstallerResult<()> {
    let sub = wide(subkey);
    let rc = unsafe { RegDeleteTreeW(root(hive), PCWSTR(sub.as_ptr())) };
    if rc.is_ok() || rc.0 == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(other(format!("RegDeleteTreeW({subkey}) failed: {rc:?}")))
    }
}

/// Whether `value_name` exists under `subkey` in `hive`. Used by detection
/// to tell an entry we wrote from a foreign one.
pub fn value_exists(hive: RegistryHive, subkey: &str, value_name: &str) -> bool {
    let sub = wide(subkey);
    let val = wide(value_name);
    let mut cb: u32 = 0;
    let rc = unsafe {
        RegGetValueW(
            root(hive),
            PCWSTR(sub.as_ptr()),
            PCWSTR(val.as_ptr()),
            RRF_RT_ANY,
            None,
            None,
            Some(&mut cb),
        )
    };
    rc.is_ok() || rc.0 == ERROR_MORE_DATA
}

/// Whether `subkey` exists at all under `hive`.
pub fn key_exists(hive: RegistryHive, subkey: &str) -> bool {
    open_read(hive, subkey).is_some()
}
