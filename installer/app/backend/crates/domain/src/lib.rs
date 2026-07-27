//! `installer-domain` — pure types and rules for the Clippity installer.
//!
//! Everything here is deterministic and I/O-free: it computes install
//! plans, compares versions, sums component sizes, and derives the
//! progress checklists. That makes the interesting decisions unit-
//! testable without a filesystem or a desktop session. Serde field
//! renaming keeps the JSON wire shape identical to
//! `@clippity/installer-shared`.

pub mod cli;
pub mod install;
pub mod journal;
pub mod progress;
pub mod provisioning;
pub mod repair;
pub mod shutdown;
pub mod state;
pub mod uninstall;
pub mod update;
pub mod wizard;
