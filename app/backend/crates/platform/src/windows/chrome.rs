//! Custom-chrome polish for the borderless transparent Tauri windows.
//!
//! Tauri's `decorations: false` + `transparent: true` removes the title
//! bar but leaves DWM's default square frame + faint shadow behind the
//! window — visible as a semi-transparent square boundary around the
//! CSS-rounded content. Two Win32 calls fix it:
//!
//! 1. **`DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND`** — asks DWM
//!    to natively round the window's hit-test frame so it matches the
//!    CSS corner radius. Win11 only; older Windows silently ignores.
//! 2. **`window_vibrancy::apply_mica`** — paints the Win11 Mica
//!    backdrop into the otherwise-transparent area so the window
//!    reads as a deliberate frosted surface instead of an empty
//!    box. `dark = None` follows the OS theme on first apply.
//!
//! Apply both in `setup()` for every primary window that should look
//! like a "frosted card". The `overlay` and `countdown` windows are
//! excluded — both need to stay fully transparent over the desktop
//! (overlay for the region-capture snapshot, countdown for its
//! edge-to-edge status strip), and a Mica backdrop would paint a
//! visible translucent fill across them.

use tauri::{AppHandle, Manager};

/// Windows that get rounded corners + Mica backdrop. `overlay` and
/// `countdown` are intentionally absent: they're transparent utility
/// overlays (fullscreen region UX / taskbar-edge status strip) where a
/// Mica backdrop would obscure the desktop behind them. The legacy
/// `MICA_WINDOWS` list included countdown because its countdown was a
/// small frosted card; the rebuilt countdown is a chromeless strip, so
/// it drops out here. The `tray` flyout panel, by contrast, IS a frosted
/// card (like `toast`), so it joins the list.
pub const FROSTED_WINDOWS: &[&str] = &["capture", "main", "toast", "tray"];

/// Ask DWM to natively round each frosted window's frame so the
/// CSS-rounded content isn't surrounded by a square Win32 border.
///
/// Silent no-op on Windows < 11 (DWM ignores the attribute).
#[cfg(target_os = "windows")]
pub fn round_window_corners(app: &AppHandle) {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    for label in FROSTED_WINDOWS {
        let Some(win) = app.get_webview_window(label) else {
            // Window not created yet (e.g. main is `visible: false` and
            // may not exist on first boot). Skip silently — apply again
            // when the window is later shown if needed.
            continue;
        };
        // Tauri pins an older `windows` crate than our direct
        // dependency, so its `HWND` struct identity differs from ours
        // even though both wrap the same raw pointer. Re-wrap to bridge
        // — both crates' `HWND` is `HWND(pub *mut c_void)` so no cast
        // is needed; modern clippy enforces this (legacy used `as *mut
        // c_void` redundantly).
        let Ok(tauri_hwnd) = win.hwnd() else {
            continue;
        };
        let hwnd = HWND(tauri_hwnd.0);
        let pref = DWMWCP_ROUND;
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &pref as *const _ as *const c_void,
                std::mem::size_of_val(&pref) as u32,
            );
        }
    }
}

/// Paint the Windows 11 Mica backdrop into every frosted window.
/// `dark = None` follows the OS theme (used at boot); the frontend
/// pushes its persisted choice down via the `apply_window_theme`
/// command on mount + every theme flip.
///
/// Errors are intentionally swallowed — Mica is a polish, not a
/// correctness concern, and we'd rather degrade to a flat translucent
/// background than fail boot on a Win10 machine.
#[cfg(target_os = "windows")]
pub fn apply_backdrop(app: &AppHandle, dark: Option<bool>) {
    for label in FROSTED_WINDOWS {
        if let Some(win) = app.get_webview_window(label) {
            let _ = window_vibrancy::apply_mica(&win, dark);
        }
    }
}

/// Strip the Mica backdrop from every frosted window. Used when the
/// `performance.window_effects` setting is off so the windows fall back
/// to their flat opaque canvas. Errors are swallowed for the same reason
/// `apply_backdrop` swallows them — the backdrop is polish, not
/// correctness.
#[cfg(target_os = "windows")]
pub fn clear_backdrop(app: &AppHandle) {
    for label in FROSTED_WINDOWS {
        if let Some(win) = app.get_webview_window(label) {
            let _ = window_vibrancy::clear_mica(&win);
        }
    }
}

/// Apply or clear the Mica backdrop in one call, driven by the
/// `performance.window_effects` setting. On (the default) tints Mica to
/// the resolved theme; off strips it so the window reads as a flat
/// opaque surface — the frontend simultaneously drops `backdrop-filter`
/// blur via `data-effects="flat"`, so the pair together removes the DWM
/// compositor + GPU cost of the frosted chrome.
#[cfg(target_os = "windows")]
pub fn refresh_backdrop(app: &AppHandle, dark: bool, effects: bool) {
    if effects {
        apply_backdrop(app, Some(dark));
    } else {
        clear_backdrop(app);
    }
}

/// Toggle `WDA_EXCLUDEFROMCAPTURE` on a window so it's invisible to
/// screen-capture APIs (it still renders for the user). Used to keep the
/// recording HUD toast out of the frames the scroll-capture worker grabs
/// (ADR 0008). Silent no-op if the HWND can't be resolved.
#[cfg(target_os = "windows")]
pub fn set_capture_excluded(win: &tauri::WebviewWindow, excluded: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    let Ok(tauri_hwnd) = win.hwnd() else {
        return;
    };
    // Tauri pins an older `windows` crate; re-wrap the raw pointer (both
    // are `HWND(*mut c_void)`), same bridge as `round_window_corners`.
    let hwnd = HWND(tauri_hwnd.0);
    let affinity = if excluded {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    unsafe {
        let _ = SetWindowDisplayAffinity(hwnd, affinity);
    }
}
