//! Tunable constants for cross-cutting concerns.
//!
//! Everything that's "a magic number that ought to have a name" lands
//! here. Values are inherited from the legacy implementation where one
//! existed and confirmed during the corresponding feature's Step 4
//! manual validation. Per-platform tuning (e.g. faster machines vs.
//! slower hardware) belongs in `#[cfg(target_os = …)]` blocks here, not
//! scattered through the services.

use std::time::Duration;

/// How long to wait for the compositor to unpaint the capture window
/// before grabbing a fullscreen shot — the capture path's live-regrab
/// fallback.
///
/// The overlay open path used to have a 260 ms sibling of this. It was
/// replaced by `window_service::settle_after_hide`, which waits on the
/// actual hide (`IsWindowVisible`) rather than sleeping a fixed worst
/// case; the fixed sleep survives only on the capture fallbacks, which
/// re-grab rarely and off the interactive open path.
pub const COMPOSITOR_UNPAINT_CAPTURE_MS: u64 = 120;

pub fn capture_unpaint_sleep() -> Duration {
    Duration::from_millis(COMPOSITOR_UNPAINT_CAPTURE_MS)
}

/// Compositor margin applied *after* a hidden window is confirmed gone
/// (`window_service::settle_after_hide`), before the snapshot is grabbed.
///
/// This is no longer a guess at how long `.hide()` takes to be processed
/// — that wait is now deterministic (poll `IsWindowVisible` until the
/// window's style bit clears). This is only the small tail between the
/// window leaving the composited surface and `DwmFlush` confirming a
/// clean frame. A blind 260 ms sleep used to cover *both* unknowns; the
/// deterministic wait removed the large, variable one.
///
/// **If ghost pixels of the capture window ever reappear in a snapshot,
/// raise this first** — it is the remaining safety margin.
pub const COMPOSITOR_UNPAINT_FLOOR_MS: u64 = 40;

/// How long to wait for a hidden primary window to actually leave the
/// composited desktop before grabbing anyway.
///
/// The common path never spends this: the poll exits the instant
/// `IsWindowVisible` reports the window down, usually within a frame or
/// two. It is a backstop for a wedged message pump, bounded so a stuck
/// hide can't hang a capture — and set no longer than the old blind
/// sleep, so the worst case is never worse than before.
pub const COMPOSITOR_HIDE_TIMEOUT_MS: u64 = 300;

/// DWM composition frames to block on once the window is confirmed hidden.
///
/// Each `DwmFlush` returns on the next composition, so this is bounded by
/// the refresh rate (~67 ms at 60 Hz, ~24 ms at 165 Hz) and self-tunes to
/// the display rather than to a guess. Flushing only *after* the hide is
/// confirmed is the fix: a flush issued while the window is still up
/// presents a frame that still contains it.
pub const COMPOSITOR_SETTLE_FLUSHES: u32 = 3;

pub fn compositor_unpaint_floor() -> Duration {
    Duration::from_millis(COMPOSITOR_UNPAINT_FLOOR_MS)
}

pub fn compositor_hide_timeout() -> Duration {
    Duration::from_millis(COMPOSITOR_HIDE_TIMEOUT_MS)
}
