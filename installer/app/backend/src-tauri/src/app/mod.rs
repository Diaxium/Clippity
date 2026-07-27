//! Tauri-facing layer: command handlers and shared state.
//!
//! Commands are kept **thin**: they validate the request, call a
//! `installer-services` function (which performs I/O and, for
//! long-running operations, emits progress events), and map the result
//! back to a serializable response. No installer logic lives here — that
//! belongs in `installer-domain` (rules) and `installer-services` (I/O).

pub mod cli;
pub mod commands;
pub mod state;

/// The event name the progress steps stream over. The frontend subscribes
/// with `listen("installer://progress", …)`.
pub const PROGRESS_EVENT: &str = "installer://progress";
