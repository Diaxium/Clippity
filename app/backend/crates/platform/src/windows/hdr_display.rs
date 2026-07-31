//! Is this display in HDR mode, and what does it call white?
//!
//! Two questions, both answered per-monitor, and both needed *before* a
//! capture rather than after: the answer decides which capture path runs
//! (see `hdr_capture`), and a tone map without the white level is worse
//! than no tone map at all.
//!
//! They come from two different Windows APIs because Windows keeps them
//! in two different places. DXGI knows the output's colour space, which
//! is what "HDR is on" actually means. Only the display-config API knows
//! the SDR white level, which is the user-facing "SDR content
//! brightness" slider and moves independently of everything else.
//!
//! Every function here is best-effort: a display that will not answer
//! yields `None` or a default, never an error. A capture must not fail
//! because a monitor was vague about its colour space.

use windows::core::Interface;
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL, DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
    DISPLAYCONFIG_DEVICE_INFO_HEADER, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_SDR_WHITE_LEVEL, DISPLAYCONFIG_SOURCE_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::Graphics::Dxgi::Common::DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIAdapter1, IDXGIFactory1, IDXGIOutput6, DXGI_ERROR_NOT_FOUND,
};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFOEXW};

use clippity_domain::hdr::DEFAULT_SDR_WHITE_NITS;

/// What we know about one monitor's colour handling.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayColorInfo {
    /// The output is presenting in an HDR colour space right now. This
    /// is a *mode*, not a capability — a monitor that supports HDR with
    /// the toggle off is `false`, and correctly so: with HDR off the
    /// ordinary 8-bit capture path is already right.
    pub hdr_active: bool,
    /// Nits the display calls SDR white. Falls back to
    /// [`DEFAULT_SDR_WHITE_NITS`] when unreadable.
    pub sdr_white_nits: f32,
}

impl Default for DisplayColorInfo {
    fn default() -> Self {
        Self {
            hdr_active: false,
            sdr_white_nits: DEFAULT_SDR_WHITE_NITS,
        }
    }
}

/// Describe `hmonitor`'s colour handling.
///
/// Returns the SDR default for any monitor that cannot be interrogated,
/// which routes the caller down the ordinary capture path — the safe
/// direction to fail in, since that is what shipped before this existed.
pub fn describe(hmonitor: HMONITOR) -> DisplayColorInfo {
    DisplayColorInfo {
        hdr_active: output_is_hdr(hmonitor).unwrap_or(false),
        sdr_white_nits: sdr_white_nits(hmonitor).unwrap_or(DEFAULT_SDR_WHITE_NITS),
    }
}

/// Walk the DXGI adapters for the output backing `hmonitor` and read
/// its colour space.
///
/// ST.2084 (PQ) over Rec.2020 is what Windows switches an output to when
/// the HDR toggle goes on, and is the only colour space where the
/// desktop is composed in scRGB — which is the thing that makes an
/// 8-bit grab wrong.
fn output_is_hdr(hmonitor: HMONITOR) -> Option<bool> {
    // SAFETY: DXGI enumeration. Every interface is released by `windows`
    // on drop, and each `Enum*` call is bounds-checked by its own
    // `DXGI_ERROR_NOT_FOUND` terminator rather than by an assumed count.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().ok()?;
        for adapter_index in 0.. {
            let adapter: IDXGIAdapter1 = match factory.EnumAdapters1(adapter_index) {
                Ok(a) => a,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(_) => break,
            };
            for output_index in 0.. {
                let output = match adapter.EnumOutputs(output_index) {
                    Ok(o) => o,
                    Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                    Err(_) => break,
                };
                // Output6 is where `GetDesc1` — and therefore the colour
                // space — lives. Absent on very old drivers, which is
                // itself a reliable "this is not an HDR setup".
                let Ok(output6) = output.cast::<IDXGIOutput6>() else {
                    continue;
                };
                let Ok(desc) = output6.GetDesc1() else {
                    continue;
                };
                if desc.Monitor == hmonitor {
                    return Some(desc.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020);
                }
            }
        }
    }
    None
}

/// Read the "SDR content brightness" level for `hmonitor`, in nits.
///
/// Matched by GDI device name (`\\.\DISPLAY1`), because that is the only
/// identifier both `GetMonitorInfoW` and the display-config path table
/// agree on — the config API is keyed by adapter LUID and target id,
/// neither of which an `HMONITOR` carries.
fn sdr_white_nits(hmonitor: HMONITOR) -> Option<f32> {
    let wanted = monitor_device_name(hmonitor)?;

    // SAFETY: the two-call sizing pattern the display-config API
    // documents — ask for the counts, allocate exactly that, then fill.
    unsafe {
        let (mut path_count, mut mode_count) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count)
            != ERROR_SUCCESS
        {
            return None;
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut path_count,
            paths.as_mut_ptr(),
            &mut mode_count,
            modes.as_mut_ptr(),
            None,
        ) != ERROR_SUCCESS
        {
            return None;
        }

        for path in paths.iter().take(path_count as usize) {
            let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size: size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32,
                    adapterId: path.sourceInfo.adapterId,
                    id: path.sourceInfo.id,
                },
                ..Default::default()
            };
            if DisplayConfigGetDeviceInfo(&mut source.header) != ERROR_SUCCESS.0 as i32 {
                continue;
            }
            if wide_to_string(&source.viewGdiDeviceName) != wanted {
                continue;
            }

            // Keyed off the *target* for the white level — the source is
            // the desktop surface, the target is the panel, and
            // brightness is a property of the panel.
            let mut white = DISPLAYCONFIG_SDR_WHITE_LEVEL {
                header: DISPLAYCONFIG_DEVICE_INFO_HEADER {
                    r#type: DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL,
                    size: size_of::<DISPLAYCONFIG_SDR_WHITE_LEVEL>() as u32,
                    adapterId: path.targetInfo.adapterId,
                    id: path.targetInfo.id,
                },
                ..Default::default()
            };
            if DisplayConfigGetDeviceInfo(&mut white.header) != ERROR_SUCCESS.0 as i32 {
                continue;
            }
            return Some(white_level_to_nits(white.SDRWhiteLevel));
        }
    }
    None
}

/// Convert the display-config API's `SDRWhiteLevel` to nits.
///
/// The API reports the level as a multiple of the scRGB reference white
/// scaled by 1000 — so the documented identity is
/// `nits = level / 1000 * 80`, and the value 1000 means "SDR white is
/// the 80-nit reference", which is what a display in SDR mode reports.
///
/// Pure, so the one piece of this file that is easy to get wrong by a
/// factor of 12.5 can be tested without a monitor.
pub fn white_level_to_nits(level: u32) -> f32 {
    if level == 0 {
        // Zero is "didn't answer", not "a black display". Handing it on
        // would make the tone map divide the frame into white.
        return DEFAULT_SDR_WHITE_NITS;
    }
    level as f32 / 1000.0 * 80.0
}

/// `\\.\DISPLAY1`-style GDI name for a monitor handle.
fn monitor_device_name(hmonitor: HMONITOR) -> Option<String> {
    let mut info = MONITORINFOEXW {
        monitorInfo: windows::Win32::Graphics::Gdi::MONITORINFO {
            cbSize: size_of::<MONITORINFOEXW>() as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    // SAFETY: `cbSize` declares the extended struct, which is what makes
    // `szDevice` populated rather than left as the plain `MONITORINFO`.
    let ok = unsafe { GetMonitorInfoW(hmonitor, &mut info as *mut _ as *mut _) };
    if !ok.as_bool() {
        return None;
    }
    Some(wide_to_string(&info.szDevice))
}

/// NUL-terminated fixed-width UTF-16 field to a `String`.
fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_display_in_sdr_mode_reports_the_reference_white() {
        // 1000 is the API's "no HDR adjustment" value, and 80 nits is
        // the scRGB reference it corresponds to.
        assert_eq!(white_level_to_nits(1000), 80.0);
    }

    #[test]
    fn a_typical_hdr_desktop_reports_around_two_hundred_nits() {
        // What Windows lands on at the middle of the "SDR content
        // brightness" slider — the value this whole conversion exists
        // to pick up.
        assert_eq!(white_level_to_nits(2500), 200.0);
    }

    #[test]
    fn an_unanswered_white_level_falls_back_rather_than_reading_as_black() {
        // Zero would otherwise scale a frame to solid white.
        assert_eq!(white_level_to_nits(0), DEFAULT_SDR_WHITE_NITS);
    }

    #[test]
    fn the_default_description_routes_to_the_ordinary_capture_path() {
        // The safe failure direction: unknown means SDR, which is what
        // shipped before any of this existed.
        let d = DisplayColorInfo::default();
        assert!(!d.hdr_active);
        assert_eq!(d.sdr_white_nits, DEFAULT_SDR_WHITE_NITS);
    }

    #[test]
    fn a_wide_field_stops_at_its_terminator() {
        let mut buf = [0u16; 32];
        for (i, c) in "\\\\.\\DISPLAY1".encode_utf16().enumerate() {
            buf[i] = c;
        }
        assert_eq!(wide_to_string(&buf), "\\\\.\\DISPLAY1");
    }

    #[test]
    fn a_field_with_no_terminator_still_reads() {
        assert_eq!(wide_to_string(&[b'a' as u16, b'b' as u16]), "ab");
    }

    /// What the HDR check costs on the capture hot path.
    ///
    /// [`describe`] runs before *every* capture, on SDR machines too,
    /// so its cost is paid by users who will never benefit from it.
    /// This pins it against the budget: a monitor grab is tens of
    /// milliseconds, so anything around a millisecond is free and
    /// anything approaching ten is not.
    #[test]
    #[ignore = "needs a desktop session with a monitor attached"]
    fn the_hdr_check_is_cheap_enough_to_run_before_every_capture() {
        use std::time::Instant;
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

        // SAFETY: DEFAULTTOPRIMARY always resolves to a monitor.
        let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };

        // One warm-up: the first DXGI factory in a process pays for
        // loading the runtime, which a capture would not repeat.
        let _ = describe(hmon);

        const RUNS: u32 = 20;
        let started = Instant::now();
        for _ in 0..RUNS {
            let _ = describe(hmon);
        }
        let each = started.elapsed() / RUNS;
        println!("describe() averaged {each:?} over {RUNS} runs");
        assert!(
            each.as_millis() < 10,
            "the HDR check costs {each:?} per capture, which is no longer free"
        );
    }

    /// Live check against whatever this machine has attached.
    ///
    /// `#[ignore]`d: it asserts nothing about *which* answer is right —
    /// that depends on the desk it runs on — only that the queries
    /// complete and produce a self-consistent, physically plausible
    /// description. Run it with `-- --ignored` to see the real values.
    #[test]
    #[ignore = "needs a desktop session with a monitor attached"]
    fn describes_the_real_monitors_on_this_machine() {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

        // SAFETY: a null-ish point with DEFAULTTOPRIMARY always resolves.
        let hmon = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
        let info = describe(hmon);
        println!("primary monitor: {info:?}");
        assert!(
            info.sdr_white_nits >= 80.0 && info.sdr_white_nits <= 1000.0,
            "implausible SDR white level {}",
            info.sdr_white_nits
        );
    }
}
