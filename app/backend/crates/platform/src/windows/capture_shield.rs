//! Exclude Clippity's own windows from screen capture.
//!
//! `SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` tells DWM to
//! keep a window on the visible display but omit it from the capture
//! pipeline — a capturer sees straight through to whatever is behind it.
//! Applied to every Clippity window, it means the desktop snapshot the
//! overlay grabs can never contain our own chrome, *regardless of whether
//! that chrome has finished hiding*. That is what lets the open path drop
//! the hide-then-wait-for-the-compositor dance: the snapshot is clean by
//! construction, not by timing.
//!
//! The flag is Windows 10 2004 (build 19041) and newer. On older builds
//! `SetWindowDisplayAffinity` fails for `WDA_EXCLUDEFROMCAPTURE`; callers
//! treat that as "not available" and keep the hide-and-wait fallback.

#[cfg(target_os = "windows")]
use tauri::{AppHandle, Manager};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

/// Every Clippity window. All of them are shielded: the desktop snapshot
/// must never contain *any* of our chrome — the capture window it was
/// launched from, the overlay drawing the snapshot, or a dashboard/toast
/// that happens to be up — so the shield is what makes "grab the desktop
/// without waiting for our windows to hide" correct.
#[cfg(target_os = "windows")]
const SHIELDED_WINDOWS: &[&str] = &[
    "capture",
    "main",
    "overlay",
    "toast",
    "tray",
    "countdown",
    // The recording outline sits *on top of the area being recorded*,
    // so of every window here this is the one that would most obviously
    // ruin the output if it were ever captured.
    "recorder-frame",
];

/// Exclude every Clippity window from screen capture (see module docs).
///
/// Best-effort per window: a window that isn't built yet, or an older
/// Windows that rejects the flag, is skipped. Returns whether *every*
/// present window was shielded — the overlay open path uses that to
/// decide whether it can trust the snapshot to be self-clean or must
/// fall back to hiding-and-waiting.
#[cfg(target_os = "windows")]
pub fn shield_windows(app: &AppHandle) -> bool {
    let mut all_ok = true;
    for label in SHIELDED_WINDOWS {
        let Some(win) = app.get_webview_window(label) else {
            continue; // not created yet — nothing on screen to leak
        };
        // Tauri pins an older `windows` crate, so re-wrap its `HWND` into
        // ours; both are `HWND(*mut c_void)` over the same handle. Same
        // bridge `chrome::round_window_corners` uses.
        let Ok(tauri_hwnd) = win.hwnd() else {
            all_ok = false;
            continue;
        };
        if !exclude_from_capture(HWND(tauri_hwnd.0)) {
            all_ok = false;
        }
    }
    all_ok
}

/// Ask DWM to exclude `hwnd` from all screen capture while leaving it
/// visible on the monitor. Returns whether the call succeeded — `false`
/// on Windows older than 2004, where the caller must not assume the
/// snapshot is self-clean.
#[cfg(target_os = "windows")]
pub fn exclude_from_capture(hwnd: HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };
    // Safety: `hwnd` is a live top-level window owned by this process
    // (Tauri created it and still holds it). The call only sets a DWM
    // attribute; it neither stores the handle nor frees anything.
    unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE).is_ok() }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    //! Empirical check that capture exclusion actually works on *this*
    //! machine and display, through the exact capture path the app uses
    //! (xcap's GDI `BitBlt`). Ignored by default — it creates a real
    //! on-screen window and grabs the primary monitor, so it needs a
    //! desktop session, and it flashes a small magenta square. Run when
    //! deciding whether the affinity approach is viable here:
    //!
    //! ```text
    //! cargo test -p clippity-platform --lib capture_shield -- --ignored --nocapture
    //! ```

    use windows::core::w;
    use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Dwm::DwmFlush;
    use windows::Win32::Graphics::Gdi::CreateSolidBrush;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
        RegisterClassW, SetWindowDisplayAffinity, ShowWindow, UnregisterClassW, MSG, PM_REMOVE,
        SW_SHOWNOACTIVATE, WDA_NONE, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
        WS_POPUP, WS_VISIBLE,
    };

    use super::exclude_from_capture;

    /// `WNDCLASSW.lpfnWndProc` wants a raw `extern "system"` pointer; the
    /// crate's `DefWindowProcW` is a Rust-callable wrapper, so bounce
    /// through this trivial proc.
    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wp: WPARAM,
        lp: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wp, lp)
    }

    /// Opaque magenta — vivid and vanishingly unlikely to occur on a real
    /// desktop, so counting it in the capture is a reliable presence test.
    const MAGENTA: u32 = 0x00FF_00FF; // COLORREF 0x00bbggrr → B=FF,G=00,R=FF

    fn is_magenta(p: &image::Rgba<u8>) -> bool {
        p[0] > 200 && p[1] < 60 && p[2] > 200
    }

    /// Count magenta-ish pixels across the primary monitor grab.
    fn magenta_pixels_in_primary_capture() -> u64 {
        let monitors = xcap::Monitor::all().expect("monitors");
        let primary = monitors
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .expect("a monitor");
        let img = primary.capture_image().expect("capture");
        img.pixels().filter(|p| is_magenta(p)).count() as u64
    }

    /// Pump this thread's queue and force a DWM composition so the window
    /// we just changed is actually on (or off) the composited desktop
    /// before we grab it.
    fn settle() {
        unsafe {
            let mut msg = MSG::default();
            for _ in 0..64 {
                if !PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    break;
                }
                let _ = DispatchMessageW(&msg);
            }
            let _ = DwmFlush();
            let _ = DwmFlush();
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }

    #[test]
    #[ignore = "creates a real on-screen window and grabs the screen; run manually to validate the display"]
    fn exclude_from_capture_actually_hides_the_window_from_xcap() {
        unsafe {
            let class_name = w!("ClippityCaptureShieldProbe");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hbrBackground: CreateSolidBrush(COLORREF(MAGENTA)),
                lpszClassName: class_name,
                ..Default::default()
            };
            let atom = RegisterClassW(&wc);
            assert_ne!(atom, 0, "register class");

            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                class_name,
                w!("shield-probe"),
                WS_POPUP | WS_VISIBLE,
                200,
                200,
                400,
                400,
                None,
                None,
                None,
                None,
            )
            .expect("create window");

            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            settle();

            // 1. Sanity — without the flag the window is plainly in the grab.
            let before = magenta_pixels_in_primary_capture();

            // 2. The flag under test.
            let applied = exclude_from_capture(hwnd);
            settle();
            let excluded = magenta_pixels_in_primary_capture();

            // 3. Put it back, to be sure the change was the cause.
            let _ = SetWindowDisplayAffinity(hwnd, WDA_NONE);
            settle();
            let restored = magenta_pixels_in_primary_capture();

            let _ = DestroyWindow(hwnd);
            let _ = UnregisterClassW(class_name, None);

            println!("\n--- capture-shield probe (xcap GDI path) ---");
            println!("affinity supported (call ok):   {applied}");
            println!("magenta px, no affinity:        {before}");
            println!("magenta px, WDA_EXCLUDE:        {excluded}");
            println!("magenta px, restored:           {restored}");
            println!(
                "verdict: exclusion {} on this display\n",
                if applied && before > 0 && excluded == 0 && restored > 0 {
                    "WORKS"
                } else {
                    "does NOT work (fallback to hide-and-wait needed)"
                }
            );

            assert!(before > 0, "probe window wasn't even captured — test setup is wrong");
        }
    }
}
