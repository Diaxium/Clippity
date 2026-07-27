//! Synthetic mouse input for the Panoramic (auto-scroll) capture.
//!
//! Panoramic capture drives the scroll itself instead of waiting on the
//! user: it parks the cursor over the captured region and sends mouse-
//! wheel input, so whatever scrollable surface is under that point
//! advances one step per capture tick. SendInput with a positioned
//! cursor is the path the OS treats exactly like a real wheel scroll, so
//! it works across browsers, document viewers, chat apps, etc. — far
//! more reliable than synthesizing `WM_MOUSEWHEEL` to a guessed child
//! window.
//!
//! `cfg(target_os = "windows")` only — gated at `platform::mod`. The
//! pure geometry (where to aim) lives in `domain::scroll`.

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};

/// Read the current cursor position in virtual-screen coordinates, so
/// the panoramic worker can restore it after it finishes driving the
/// scroll. `None` if the query fails.
pub fn cursor_pos() -> Option<(i32, i32)> {
    unsafe {
        let mut p = POINT { x: 0, y: 0 };
        GetCursorPos(&mut p).ok().map(|_| (p.x, p.y))
    }
}

/// Move the cursor to virtual-screen `(x, y)`. Best-effort — a failure
/// just means the next wheel step may land on the wrong surface, which
/// the end-of-content detector tolerates.
pub fn move_cursor(x: i32, y: i32) {
    unsafe {
        let _ = SetCursorPos(x, y);
    }
}

/// Send a mouse-wheel scroll at the current cursor position. `units` is the
/// signed wheel delta in `WHEEL_DELTA` units (120 = one physical notch);
/// sub-notch values are honoured by high-resolution-wheel-aware surfaces
/// (browsers, document viewers), which is what lets the panoramic worker
/// take a step *smaller than one notch* to keep a short region's frames
/// overlapping. `horizontal` chooses the wheel axis. Sign conventions
/// (real-wheel): vertical negative = down, horizontal positive = right.
/// No-op for zero.
pub fn scroll_wheel_units(horizontal: bool, units: i32) {
    if units == 0 {
        return;
    }
    let delta = units;
    let flags = if horizontal {
        MOUSEEVENTF_HWHEEL
    } else {
        MOUSEEVENTF_WHEEL
    };
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 0,
                dy: 0,
                // For the wheel flags, mouseData carries the signed wheel
                // delta (in WHEEL_DELTA units) reinterpreted as u32.
                mouseData: delta as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    unsafe {
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

/// Park the cursor over `(x, y)` and scroll there by `units` signed
/// `WHEEL_DELTA` units on the chosen wheel axis (one auto-scroll step).
/// Re-positioning every step keeps the wheel landing on the intended
/// surface even if focus shifts.
pub fn auto_scroll_step(x: i32, y: i32, horizontal: bool, units: i32) {
    move_cursor(x, y);
    scroll_wheel_units(horizontal, units);
}
