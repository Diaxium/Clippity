//! `installer-infra` — the bottom layer of the installer workspace.
//!
//! Cross-cutting concerns that every higher layer leans on: a single
//! error type, structured logging init, and path resolution for the
//! places an installer reads and writes (install dir, data dir, log
//! file). No installer *logic* lives here — that's `installer-domain`.

pub mod error;
pub mod logging;
pub mod paths;
pub mod retry;
