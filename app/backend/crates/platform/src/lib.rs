//! Platform-specific code, gated by `cfg(target_os = …)`.
//!
//! Anything Win32-only (DWM, UI Automation, Media.Ocr callers, cursor +
//! window enumeration) lives in `windows`. macOS and Linux equivalents go
//! in sibling modules and are surfaced through the same service traits in
//! `clippity-services` so callers never branch on the OS.

#[cfg(target_os = "windows")]
pub mod windows;
