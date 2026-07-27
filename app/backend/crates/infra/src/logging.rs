//! Tracing setup. Reads `CLIPPITY_LOG` (or `RUST_LOG`) for filters;
//! defaults to `info,clippity_lib=debug` so feature-level logs are
//! visible in dev without OS-level chatter.

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

pub fn init() {
    let filter = EnvFilter::try_from_env("CLIPPITY_LOG")
        .or_else(|_| EnvFilter::try_from_default_env())
        .unwrap_or_else(|_| EnvFilter::new("info,clippity_lib=debug"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .init();
}
