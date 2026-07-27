//! Structured logging init for the installer process.

use std::sync::Once;

static INIT: Once = Once::new();

/// Initialize the global tracing subscriber exactly once.
///
/// Honors `RUST_LOG`; defaults to `info` for the installer crates. Safe
/// to call from `main` and from tests (the `Once` guard makes repeat
/// calls no-ops).
pub fn init() {
    INIT.call_once(|| {
        use tracing_subscriber::{fmt, EnvFilter};

        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,installer=debug"));

        fmt().with_env_filter(filter).with_target(false).init();
    });
}
