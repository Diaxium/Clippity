//! Windows-only platform code.
//!
//! Sub-modules (added per feature):
//!   chrome       — DWM corner rounding + Mica backdrop for frosted windows
//!   clipboard_files — CF_HDROP file-drop copy, for putting a finished
//!                  recording on the clipboard by reference
//!   cursor       — Win32 cursor compositing (paired with overlay port)
//!   input        — synthetic mouse-wheel scroll for the Panoramic port
//!   hdr_display  — per-monitor HDR mode + SDR white level
//!   hdr_capture  — Desktop Duplication grab in scRGB FP16, for HDR
//!                  displays where an 8-bit grab comes back washed out
//!   media_foundation — H.264/AAC MP4 sink writer for the recorder (ADR 0031)
//!   media_reader — the decode counterpart: probes and re-reads a saved
//!                  clip so Studio can play and trim it
//!   nv12         — BGRA → NV12 colour conversion feeding that encoder
//!   audio        — WASAPI microphone + system-loopback capture
//!   pcm          — sample-format / rate / channel normalisation for it
//!   monitor      — Win32 cursor-monitor work-area lookup (paired with toast port)
//!   os_info      — which Windows this is, for the diagnostics card
//!   enumeration  — Win32 top-level window walking for the Window-capture port
//!                  (UIA per-element region trees stay with the later Object port)

pub mod audio;
pub mod capture_shield;
pub mod chrome;
pub mod clipboard_files;
pub mod cursor;
pub mod duplication_capture;
pub mod enumeration;
pub mod hdr_capture;
pub mod hdr_display;
pub mod input;
pub mod media_foundation;
pub mod media_reader;
pub mod monitor;
pub mod nv12;
pub mod os_info;
pub mod pcm;
pub mod webcam;

/// Shared fixtures for the live tests that touch Desktop Duplication.
///
/// Both `hdr_capture` and `duplication_capture` open a duplication of
/// the *same* primary output, and both need the process to look like the
/// shipped app before it will be granted. Keeping the two requirements
/// here means neither module can satisfy only one of them.
#[cfg(test)]
pub(crate) mod duplication_tests {
    /// Serialises every live test that duplicates an output.
    ///
    /// Desktop Duplication permits one duplication per output per
    /// process, so two of these running concurrently — the default,
    /// `cargo test` being threaded — make each other fail with
    /// `E_INVALIDARG`. That matters more than an ordinary flake: these
    /// tests treat a refusal as "not this code's fault" and return
    /// early, so the collision shows up as a test that passes without
    /// asserting anything rather than as a failure.
    static DUPLICATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Take the duplication lock, ignoring poisoning — a panic in
    /// another live test says nothing about whether this one can run.
    pub(crate) fn one_at_a_time() -> std::sync::MutexGuard<'static, ()> {
        DUPLICATION.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Give this process the DPI awareness the shipped app runs with.
    ///
    /// Not a convenience: `DuplicateOutput1` refuses with
    /// `DXGI_ERROR_UNSUPPORTED` in a DPI-unaware process, and a bare
    /// `cargo test` binary is DPI-unaware. tao makes the real app
    /// per-monitor-v2 aware before any capture runs, so a live test that
    /// skips this exercises a configuration the app is never in — every
    /// grab refuses, the refusal is indistinguishable from "this display
    /// is not HDR", and the whole path reports itself as covered.
    pub(crate) fn match_app_dpi_awareness() {
        #[link(name = "user32")]
        extern "system" {
            fn SetProcessDpiAwarenessContext(value: isize) -> i32;
        }
        /// `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`, which is what
        /// tao sets. Idempotent; a later call in the same process simply
        /// returns false.
        const PER_MONITOR_AWARE_V2: isize = -4;
        // SAFETY: a documented user32 call taking a constant.
        unsafe { SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) };
    }
}
