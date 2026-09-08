//! Per-user Windows startup registration used by Settings.

use std::iter::once;
use std::path::Path;

use clippity_infra::error::{AppError, AppResult};
use windows::core::PCWSTR;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
    KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};

const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "Clippity";
const ERROR_FILE_NOT_FOUND: u32 = 2;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(once(0)).collect()
}

/// Reconcile the Run value with the persisted setting. Idempotent and scoped
/// to the current user, matching the installer's registration.
pub fn set_enabled(exe: &Path, enabled: bool) -> AppResult<()> {
    let subkey = wide(RUN_SUBKEY);
    let mut key = HKEY::default();
    unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            None,
        )
    }
    .ok()
    .map_err(|e| AppError::Settings(format!("could not open Windows startup settings: {e}")))?;

    let name = wide(RUN_VALUE);
    let result = if enabled {
        let command = wide(&format!("\"{}\"", exe.display()));
        let bytes =
            unsafe { std::slice::from_raw_parts(command.as_ptr().cast::<u8>(), command.len() * 2) };
        unsafe { RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(bytes)) }
            .ok()
            .map_err(|e| AppError::Settings(format!("could not enable startup: {e}")))
    } else {
        let status = unsafe { RegDeleteValueW(key, PCWSTR(name.as_ptr())) };
        if status.is_ok() || status.0 == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            Err(AppError::Settings(format!(
                "could not disable startup: {status:?}"
            )))
        }
    };
    unsafe {
        let _ = RegCloseKey(key);
    }
    result
}
