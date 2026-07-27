//! Tauri-facing layer: command handlers, event emitters, shared state.
//!
//! Commands are kept **thin**. They:
//! 1. Deserialize and validate the request payload (delegating to
//!    `domain` for type/rule checks).
//! 2. Call into `services` to perform any I/O.
//! 3. Map results into a serializable response and return.
//!
//! No business logic lives here. If a handler grows past ~20 lines or
//! starts branching on domain rules, the rule belongs in `domain` and
//! the I/O step belongs in `services`.

pub mod commands;
pub mod state;
