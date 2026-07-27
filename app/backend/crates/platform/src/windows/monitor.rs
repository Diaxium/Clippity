//! Win32 monitor introspection — used by the toast positioner.
//!
//! `cursor_monitor_work_area()` resolves the cursor's current monitor
//! and returns its work-area rectangle (taskbar excluded). The toast
//! anchors against this rectangle so it lands on whichever monitor
//! the user is looking at, not the primary monitor.
//!
//! Outside Windows, `ToastService` falls back to `primary_monitor()`
//! via Tauri's cross-platform API — no equivalent lives here.

use std::mem::size_of;

use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// Work-area rectangle of the monitor under the system cursor.
/// Returns `(x, y, width, height)` in physical pixels, or `None` if
/// either Win32 call fails.
///
/// Work area = monitor bounds minus taskbar (whatever side it's on),
/// which is what the toast anchors against so it doesn't slide under
/// the taskbar.
pub fn cursor_monitor_work_area() -> Option<(i32, i32, u32, u32)> {
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut p).is_err() {
            return None;
        }
        let hmon = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
        if hmon.is_invalid() {
            return None;
        }
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(hmon, &mut info).as_bool() {
            return None;
        }
        let r = info.rcWork;
        let w = (r.right - r.left).max(0) as u32;
        let h = (r.bottom - r.top).max(0) as u32;
        Some((r.left, r.top, w, h))
    }
}
