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
//!   nv12         — BGRA → NV12 colour conversion feeding that encoder
//!   audio        — WASAPI microphone + system-loopback capture
//!   pcm          — sample-format / rate / channel normalisation for it
//!   monitor      — Win32 cursor-monitor work-area lookup (paired with toast port)
//!   enumeration  — Win32 top-level window walking for the Window-capture port
//!                  (UIA per-element region trees stay with the later Object port)

pub mod audio;
pub mod capture_shield;
pub mod chrome;
pub mod clipboard_files;
pub mod cursor;
pub mod enumeration;
pub mod hdr_capture;
pub mod hdr_display;
pub mod input;
pub mod media_foundation;
pub mod monitor;
pub mod nv12;
pub mod pcm;
