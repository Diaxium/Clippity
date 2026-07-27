//! Startup + runtime diagnostics.
//!
//! One place to emit the environment summary that turns a vague bug
//! report ("capture didn't save") into an actionable one ("captures dir
//! was a read-only network path"). Everything here logs through
//! `tracing` and stays on the machine — nothing is transmitted. The
//! paths recorded are the app's *own* data directories, which are
//! exactly what "where did my capture go?" triage needs and are safe to
//! write to a local log.

use crate::paths::AppPaths;

/// Compact summary of the boot-time settings that most often explain
/// odd runtime behaviour. Deliberately limited to booleans + the
/// captures dir so the banner never records anything user-identifying
/// beyond the app's own folders.
pub struct SettingsSummary {
    /// The *effective* captures dir (user override, or the fallback).
    pub captures_dir: String,
    /// True when no user override is set (captures land in `AppPaths`).
    pub captures_dir_is_default: bool,
    pub gpu_acceleration: bool,
    pub window_effects: bool,
    pub theme: &'static str,
    pub onboarded: bool,
}

/// Emit the one-time startup banner: build/version, OS/arch, the
/// resolved app directories, and a settings summary. Logged at `info`
/// so it shows up under the default filter and anchors every session's
/// log with the environment it ran in. Structured fields (rendered as
/// `key=value` by the fmt subscriber) keep each line greppable.
pub fn log_startup(paths: &AppPaths, settings: &SettingsSummary) {
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "clippity starting"
    );
    tracing::info!(
        data = %paths.data.display(),
        captures = %paths.captures.display(),
        cache = %paths.cache.display(),
        models = %paths.models.display(),
        "resolved app paths"
    );
    tracing::info!(
        captures_dir = %settings.captures_dir,
        captures_default = settings.captures_dir_is_default,
        gpu = settings.gpu_acceleration,
        window_effects = settings.window_effects,
        theme = settings.theme,
        onboarded = settings.onboarded,
        "settings summary"
    );
}
