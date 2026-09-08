//! Structured logging init for the installer process.

use std::path::Path;
use std::sync::{Mutex, Once};

static INIT: Once = Once::new();

/// Initialize the global tracing subscriber exactly once.
///
/// Honors `RUST_LOG`; defaults to `info` for the installer crates. Safe
/// to call from `main` and from tests (the `Once` guard makes repeat
/// calls no-ops).
pub fn init() {
    init_to(None);
}

/// Initialize logging, optionally appending to the CLI-requested log file.
pub fn init_to(path: Option<&Path>) {
    INIT.call_once(|| {
        use tracing_subscriber::{fmt, EnvFilter};

        let filter = EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,installer=debug"));

        if let Some(path) = path {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Ok(file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                fmt()
                    .with_env_filter(filter)
                    .with_target(false)
                    .with_ansi(false)
                    .with_writer(Mutex::new(file))
                    .init();
                return;
            }
        }
        fmt().with_env_filter(filter).with_target(false).init();
    });
}
