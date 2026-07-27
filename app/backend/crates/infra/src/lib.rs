//! Infrastructure — cross-cutting concerns shared by every layer.
//!
//! `infra` is the base crate: it does NOT depend on `domain`, `services`,
//! `platform`, or the app. The direction is one-way — anyone can pull
//! errors / logging / paths / the outbound event channel in.

pub mod config;
pub mod diagnostics;
pub mod error;
pub mod events;
pub mod logging;
pub mod paths;
