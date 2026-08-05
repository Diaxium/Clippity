//! Platform-specific code, gated by `cfg(target_os = …)`.
//!
//! Anything Win32-only (DWM, UI Automation, Media.Ocr callers, cursor +
//! window enumeration) lives in `windows`. macOS and Linux equivalents go
//! in sibling modules and are surfaced through the same service traits in
//! `clippity-services` so callers never branch on the OS.
//!
//! `parallel` is the exception to the gating: splitting one frame's rows
//! across cores is the same problem on every platform, and the pool that
//! does it has no OS surface of its own.

pub mod parallel;

#[cfg(target_os = "windows")]
pub mod windows;
