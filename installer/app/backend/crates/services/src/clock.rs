//! A dependency-free UTC clock for the two timestamps the installer
//! records: an ISO-8601 instant for the manifest, and the `YYYYMMDD` form
//! Windows Installer uses for the `InstallDate` registry value.
//!
//! Avoiding a date crate keeps the installer's dependency surface (and
//! therefore its attack surface and binary size) minimal; the civil-date
//! conversion is Howard Hinnant's well-known algorithm.

use std::time::{SystemTime, UNIX_EPOCH};

/// A resolved UTC timestamp in the forms the installer needs.
pub struct Utc {
    /// `YYYY-MM-DDTHH:MM:SSZ`.
    pub iso: String,
    /// `YYYYMMDD`, the `InstallDate` format.
    pub yyyymmdd: String,
    /// `YYYYMMDDHHMMSS`, a filename-safe compact stamp for operation ids.
    pub compact: String,
}

/// The current UTC time. Falls back to the epoch if the system clock is
/// somehow before 1970 (which only affects a cosmetic timestamp).
pub fn now() -> Utc {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, mo, d, h, mi, s) = civil(secs);
    Utc {
        iso: format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z"),
        yyyymmdd: format!("{y:04}{mo:02}{d:02}"),
        compact: format!("{y:04}{mo:02}{d:02}{h:02}{mi:02}{s:02}"),
    }
}

/// Convert Unix seconds to civil `(year, month, day, hour, min, sec)`.
fn civil(secs: u64) -> (i64, u32, u32, u32, u32, u32) {
    let days = (secs / 86_400) as i64;
    let rem = (secs % 86_400) as u32;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year, m, d, h, mi, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_epoch_converts() {
        // 1_700_000_000 == 2023-11-14T22:13:20Z.
        let (y, mo, d, h, mi, s) = civil(1_700_000_000);
        assert_eq!((y, mo, d, h, mi, s), (2023, 11, 14, 22, 13, 20));
    }

    #[test]
    fn formats_are_consistent() {
        let (y, mo, d, ..) = civil(1_700_000_000);
        assert_eq!(format!("{y:04}{mo:02}{d:02}"), "20231114");
    }
}
