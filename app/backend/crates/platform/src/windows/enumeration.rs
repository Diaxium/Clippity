//! Win32 top-level window enumeration for the overlay's Window mode.
//!
//! `list_capturable_windows()` walks every top-level window via
//! `EnumWindows` (which yields them in front-to-back Z-order),
//! filters out the ones a user can't meaningfully "click to capture"
//! (hidden, minimized, cloaked, tool windows, untitled, sub-pixel),
//! and returns each survivor's **tight visible frame** —
//! `DWMWA_EXTENDED_FRAME_BOUNDS`, which excludes the invisible
//! resize-border / drop-shadow padding that `GetWindowRect` includes,
//! so the eventual crop hugs the window instead of leaving a halo of
//! desktop around it.
//!
//! Coordinates are **absolute** virtual-screen physical pixels. The
//! caller (`overlay_service`) rebases them onto the snapshot canvas
//! origin and clips to canvas bounds — see `frame_to_region` there —
//! so this module stays free of any virtual-desktop / `domain`
//! knowledge, mirroring `monitor.rs`'s primitive-tuple boundary.
//!
//! Why raw Win32 rather than `xcap::Window::all()` (used by the legacy
//! picker): hover hit-testing on overlapping windows needs a reliable
//! front-to-back Z-order, and clean crops need DWM extended-frame
//! bounds — neither of which xcap exposes dependably.

use std::ffi::c_void;
use std::mem::size_of;

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, MAX_PATH, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE,
    WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

/// A capturable top-level window in **absolute** virtual-screen
/// physical pixels. `id` is the source HWND's bits (opaque,
/// session-stable). `app` is the friendly name of the owning
/// application, or `""` when the process couldn't be queried — a
/// protected or elevated process refuses the handle, which is expected,
/// not an error.
#[derive(Debug, Clone)]
pub struct WindowFrame {
    pub id: u64,
    pub title: String,
    pub app: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Drop windows smaller than this (px²) — splash/IME/helper husks that
/// pass the other filters but aren't worth a capture target.
const MIN_WINDOW_AREA_PX: u64 = 16 * 16;

/// Enumerate capturable top-level windows, front-to-back (topmost
/// first — so a hit-test should take the first containing rect).
///
/// Each survivor's owning process is resolved here rather than lazily,
/// so window attribution can name the app without a second pass. The
/// cost is one `OpenProcess` + `QueryFullProcessImageNameW` per *kept*
/// window — tens of microseconds each, and only for windows that
/// already passed the filter, which keeps it comfortably inside the
/// overlay-open budget.
pub fn list_capturable_windows() -> Vec<WindowFrame> {
    let mut hwnds: Vec<HWND> = Vec::new();
    // SAFETY: `enum_proc` only ever dereferences the `&mut Vec<HWND>`
    // we hand it through `lparam`, and `EnumWindows` is synchronous so
    // the borrow is live for the whole call.
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut hwnds as *mut _ as isize));
    }

    let mut out = Vec::with_capacity(hwnds.len());
    for hwnd in hwnds {
        // SAFETY: each `hwnd` came straight from `EnumWindows`.
        unsafe {
            let Some(rect) = frame_bounds(hwnd) else {
                continue;
            };
            let width = (rect.right - rect.left).max(0) as u64;
            let height = (rect.bottom - rect.top).max(0) as u64;
            let title = window_title(hwnd);
            if !keep_window(
                IsWindowVisible(hwnd).as_bool(),
                IsIconic(hwnd).as_bool(),
                is_cloaked(hwnd),
                is_tool_window(hwnd),
                is_click_through(hwnd),
                title.is_empty(),
                width * height,
            ) {
                continue;
            }
            out.push(WindowFrame {
                id: hwnd.0 as usize as u64,
                title,
                app: app_name(hwnd),
                x: rect.left,
                y: rect.top,
                width: width as u32,
                height: height as u32,
            });
        }
    }
    out
}

/// Pure keep/drop decision, split out from the Win32 calls so the
/// filtering matrix is unit-testable without a live desktop.
fn keep_window(
    visible: bool,
    iconic: bool,
    cloaked: bool,
    tool_window: bool,
    click_through: bool,
    title_empty: bool,
    area_px: u64,
) -> bool {
    visible
        && !iconic
        && !cloaked
        && !tool_window
        && !click_through
        && !title_empty
        && area_px >= MIN_WINDOW_AREA_PX
}

/// `EnumWindows` callback — pushes each HWND into the `Vec<HWND>`
/// borrowed through `lparam`. Returns `TRUE` to keep enumerating.
unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let hwnds = &mut *(lparam.0 as *mut Vec<HWND>);
    hwnds.push(hwnd);
    BOOL(1) // continue enumeration
}

/// Tight visible frame (DWM extended bounds), falling back to
/// `GetWindowRect` if DWM has no answer. `None` when both fail or the
/// rect is degenerate.
unsafe fn frame_bounds(hwnd: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    let dwm = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS,
        &mut r as *mut _ as *mut c_void,
        size_of::<RECT>() as u32,
    );
    if dwm.is_ok() && r.right > r.left && r.bottom > r.top {
        return Some(r);
    }
    let mut r2 = RECT::default();
    if GetWindowRect(hwnd, &mut r2).is_ok() && r2.right > r2.left && r2.bottom > r2.top {
        return Some(r2);
    }
    None
}

/// DWM "cloaked" = present but not composited to the screen: a window
/// on another virtual desktop, or a suspended UWP app's ghost. These
/// pass `IsWindowVisible` but aren't really on screen, so exclude them.
unsafe fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked: u32 = 0;
    let ok = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut _ as *mut c_void,
        size_of::<u32>() as u32,
    );
    ok.is_ok() && cloaked != 0
}

/// `WS_EX_TOOLWINDOW` — floating palettes / helper windows that don't
/// appear in the Alt-Tab list. Same filter the shell uses for task
/// switching, so it matches the user's mental model of "a window".
unsafe fn is_tool_window(hwnd: HWND) -> bool {
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    (ex & WS_EX_TOOLWINDOW.0) != 0
}

/// `WS_EX_LAYERED | WS_EX_TRANSPARENT` — input-transparent overlay
/// surfaces (screen-edge indicators, HUDs, notification scrims). They
/// can pass every other filter while being invisible or near-invisible
/// on screen: hit-testing one highlights "a window" the user cannot
/// see — or click — so they aren't meaningful capture targets.
unsafe fn is_click_through(hwnd: HWND) -> bool {
    let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    let mask = WS_EX_LAYERED.0 | WS_EX_TRANSPARENT.0;
    (ex & mask) == mask
}

/// The window the user was working in when a capture fired, as
/// `(title, app)` — used to give the saved file a recognisable name
/// (`domain::naming`) and to fill its provenance record
/// (`domain::metadata`). `app` is `""` when the process couldn't be
/// queried.
///
/// Returns `None` when there is no foreground window, when its title is
/// empty, or when it belongs to **our own process** (Clippity's capture
/// window / overlay). The last case matters because a capture launched
/// from Clippity's own UI would otherwise be labelled "Clippity"; the
/// naming engine then falls back to the capture-type label instead. A
/// capture triggered by a global hotkey while another app is focused
/// yields that app's title — the case where this is most useful.
pub fn foreground_window_source() -> Option<(String, String)> {
    // SAFETY: each call is a plain Win32 query against the live
    // foreground HWND; no pointers escape and the handle isn't retained.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == GetCurrentProcessId() {
            // Our own window — let the caller fall back to the type label.
            return None;
        }
        let title = window_title(hwnd);
        if title.is_empty() {
            None
        } else {
            Some((title, app_name(hwnd)))
        }
    }
}

/// [`foreground_window_source`], title only — for callers that record
/// no provenance.
pub fn foreground_window_title() -> Option<String> {
    foreground_window_source().map(|(title, _)| title)
}

unsafe fn window_title(hwnd: HWND) -> String {
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return String::new();
    }
    let mut buf = vec![0u16; (len + 1) as usize];
    let copied = GetWindowTextW(hwnd, &mut buf);
    if copied <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..copied as usize])
}

/// Friendly name of the application owning `hwnd`, or `""` when it
/// can't be resolved.
///
/// Derived from the executable path rather than the version resource's
/// file description ("Google Chrome"): reading that would mean a
/// `GetFileVersionInfo` round-trip per window plus a new Win32 feature,
/// for a string that varies by locale and installer. The executable
/// name is stable, cheap, and what a user recognises anyway once it is
/// capitalised — see [`friendly_app_name`].
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` is deliberately the narrowest
/// right that answers the question, and is the one access level that
/// succeeds against most protected processes.
unsafe fn app_name(hwnd: HWND) -> String {
    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return String::new();
    }
    let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
        // Elevated / protected processes refuse the handle. Expected —
        // the window still lists, it just goes unattributed.
        return String::new();
    };
    let mut buf = [0u16; MAX_PATH as usize];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        PWSTR(buf.as_mut_ptr()),
        &mut len,
    )
    .is_ok();
    let _ = CloseHandle(handle);
    if !ok {
        return String::new();
    }
    friendly_app_name(&String::from_utf16_lossy(&buf[..len as usize]))
}

/// Pure: executable path → the name to show a user.
///
/// Takes the file stem (dropping `.exe`) and upper-cases the first
/// letter of an all-lowercase name, which is how nearly every Windows
/// executable is shipped: `chrome.exe` → `Chrome`, `Code.exe` → `Code`,
/// `explorer.exe` → `Explorer`.
///
/// A name that already carries capitals is left exactly as-is — the
/// vendor cased it deliberately (`WINWORD`, `iTunes`), and
/// "prettifying" it would mean a hardcoded table that goes stale.
/// Returns `""` for a path with no file component.
fn friendly_app_name(exe_path: &str) -> String {
    let stem = std::path::Path::new(exe_path.trim())
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    if stem.is_empty() {
        return String::new();
    }
    let all_lower = stem.chars().all(|c| !c.is_alphabetic() || c.is_lowercase());
    if !all_lower {
        return stem.to_owned();
    }
    let mut chars = stem.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_normal_visible_titled_window() {
        assert!(keep_window(
            true,
            false,
            false,
            false,
            false,
            false,
            800 * 600
        ));
    }

    #[test]
    fn drops_invisible() {
        assert!(!keep_window(
            false,
            false,
            false,
            false,
            false,
            false,
            800 * 600
        ));
    }

    #[test]
    fn drops_minimized() {
        assert!(!keep_window(
            true,
            true,
            false,
            false,
            false,
            false,
            800 * 600
        ));
    }

    #[test]
    fn drops_cloaked_other_virtual_desktop() {
        assert!(!keep_window(
            true,
            false,
            true,
            false,
            false,
            false,
            800 * 600
        ));
    }

    #[test]
    fn drops_tool_window() {
        assert!(!keep_window(
            true,
            false,
            false,
            true,
            false,
            false,
            800 * 600
        ));
    }

    #[test]
    fn drops_click_through_overlay() {
        assert!(!keep_window(
            true,
            false,
            false,
            false,
            true,
            false,
            800 * 600
        ));
    }

    #[test]
    fn drops_untitled() {
        assert!(!keep_window(
            true,
            false,
            false,
            false,
            false,
            true,
            800 * 600
        ));
    }

    #[test]
    fn drops_sub_pixel_husk() {
        assert!(!keep_window(true, false, false, false, false, false, 4));
    }

    // ---------- friendly_app_name ----------

    #[test]
    fn capitalizes_an_all_lowercase_executable() {
        assert_eq!(
            friendly_app_name(r"C:\Program Files\Google\Chrome\chrome.exe"),
            "Chrome"
        );
        assert_eq!(friendly_app_name(r"C:\Windows\explorer.exe"), "Explorer");
        assert_eq!(friendly_app_name("/usr/bin/firefox"), "Firefox");
    }

    #[test]
    fn leaves_vendor_casing_alone() {
        // The vendor cased these deliberately; re-casing them would need
        // a hardcoded table that goes stale.
        assert_eq!(friendly_app_name(r"C:\Office\WINWORD.EXE"), "WINWORD");
        assert_eq!(friendly_app_name(r"C:\Apple\iTunes.exe"), "iTunes");
        assert_eq!(friendly_app_name(r"C:\VS\Code.exe"), "Code");
    }

    #[test]
    fn keeps_digits_and_symbols_in_the_stem() {
        assert_eq!(friendly_app_name(r"C:\x\7zFM.exe"), "7zFM");
        // Digits aren't alphabetic, so an otherwise-lowercase name is
        // still treated as lowercase and capitalized.
        assert_eq!(friendly_app_name(r"C:\x\vlc2.exe"), "Vlc2");
    }

    #[test]
    fn empty_when_there_is_no_file_component() {
        assert_eq!(friendly_app_name(""), "");
        assert_eq!(friendly_app_name("   "), "");
        assert_eq!(friendly_app_name(r"C:\"), "");
    }

    #[test]
    fn tolerates_a_path_with_no_extension() {
        assert_eq!(friendly_app_name(r"C:\tools\helper"), "Helper");
    }
}
