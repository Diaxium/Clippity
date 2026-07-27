//! `installer-services` — the I/O-performing layer.
//!
//! Each service turns a domain plan into real side effects (copying
//! files, writing registry entries, deleting data) and reports progress
//! back through a [`ProgressSink`] closure. The Tauri layer forwards
//! each emitted [`installer_domain::progress::ProgressEvent`] to the
//! wizard window.
//!
//! Steps that finish faster than the eye can follow still call [`pace`]
//! afterwards, so the checklist stays legible rather than snapping from
//! empty to complete. Steps that do real work (the payload copy, the
//! registry writes) take whatever time they take.

pub mod clock;
pub mod detect;
pub mod elevation;
pub mod install_service;
pub mod journal_store;
pub mod manifest;
pub mod payload;
pub mod provisioning_store;
pub mod recovery;
pub mod repair_service;
pub mod rollback;
pub mod shutdown;
pub mod state_store;
pub mod uninstall_service;
pub mod update_service;

use installer_domain::progress::ProgressEvent;

/// A closure the Tauri layer supplies to receive progress snapshots.
/// Kept as a trait-object callback so services stay unaware of Tauri.
pub type ProgressSink<'a> = dyn Fn(ProgressEvent) + 'a;

/// Minimum dwell time on a checklist row. Steps with little or no I/O
/// (or none left to do) hold here so the progress UI stays readable.
pub(crate) fn pace() {
    std::thread::sleep(std::time::Duration::from_millis(450));
}
