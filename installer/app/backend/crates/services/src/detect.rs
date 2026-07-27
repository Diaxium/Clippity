//! Installation detection — the Phase-6 correlation of every signal into
//! a single [`Detection`].
//!
//! No single source is trusted alone: the on-disk manifest, the Add/Remove
//! Programs registry entry, and the installed executable are gathered
//! independently and reconciled by the pure
//! [`installer_domain::state::assess`] rule. When they disagree, the
//! result is a recovery-oriented state rather than a guess.

use std::path::{Path, PathBuf};

use installer_domain::journal::{recover, OperationJournal, Recovery};
use installer_domain::state::{
    assess, Detection, DetectionInputs, InstallationManifest, SCHEMA_VERSION,
};
use installer_infra::paths::InstallerPaths;
use installer_platform::windows_ops;

use crate::{journal_store, state_store};

/// Locate the installation manifest by scanning the machine then user
/// maintenance directories. Returns the maintenance dir + parsed manifest.
pub fn locate_manifest(paths: &InstallerPaths) -> Option<(PathBuf, InstallationManifest)> {
    for all_users in [true, false] {
        let dir = paths.maintenance_dir(all_users);
        if let Ok(Some(manifest)) = state_store::read(&dir) {
            return Some((dir, manifest));
        }
    }
    None
}

/// An interrupted operation found on disk, plus the pure recovery decision
/// for it. `None` means every maintenance directory is clean — the common
/// case (a journal exists only while an operation is in flight).
#[derive(Debug, Clone)]
pub struct PendingOperation {
    /// The maintenance directory the journal was found in.
    pub maintenance_dir: PathBuf,
    pub journal: OperationJournal,
    /// What [`installer_domain::journal::recover`] says to do about it.
    pub recovery: Recovery,
}

/// Scan the machine then user maintenance directories for a leftover
/// operation journal. The presence of one means a prior install / repair /
/// update / uninstall did not reach its clean end, so the wizard should
/// surface recovery on launch rather than pretend nothing happened.
///
/// A journal that fails to parse is itself a recovery signal: it is
/// surfaced as a [`Recovery::ManualRecovery`] against an empty placeholder
/// rather than silently ignored.
pub fn scan_pending_operation(paths: &InstallerPaths) -> Option<PendingOperation> {
    for all_users in [true, false] {
        let dir = paths.maintenance_dir(all_users);
        match journal_store::read(&dir) {
            Ok(Some(journal)) => {
                let recovery = recover(&journal);
                if recovery != Recovery::None {
                    tracing::warn!(
                        dir = %dir.display(),
                        op = ?journal.operation,
                        phase = ?journal.phase,
                        ?recovery,
                        "found an unfinished operation"
                    );
                    return Some(PendingOperation {
                        maintenance_dir: dir,
                        journal,
                        recovery,
                    });
                }
                // A committed-and-cleaned-enough journal that recover() calls
                // done: drop it so it stops being reported.
                let _ = journal_store::remove(&dir);
            }
            Ok(None) => {}
            Err(e) => {
                tracing::error!(dir = %dir.display(), error = %e, "unreadable operation journal");
            }
        }
    }
    None
}

/// Whether any maintenance directory holds a manifest whose schema is
/// newer than this build understands (even if it would fail to fully
/// parse) — a signal to route the user to a newer wizard.
fn any_schema_too_new(paths: &InstallerPaths) -> bool {
    for all_users in [true, false] {
        let dir = paths.maintenance_dir(all_users);
        if let Some(v) = state_store::peek_schema_version(&dir) {
            if v > SCHEMA_VERSION {
                return true;
            }
        }
    }
    false
}

/// Resolve the full [`Detection`] shown on the maintenance hub.
pub fn detect(paths: &InstallerPaths, wizard_version: &str) -> Detection {
    // Registry signal — present in either hive, and is it ours?
    let hive = windows_ops::uninstall_hive_present();
    let registry_present = hive.is_some();
    let registry_is_ours = hive
        .map(windows_ops::uninstall_entry_is_managed)
        .unwrap_or(false);

    // Manifest signal.
    let located = locate_manifest(paths);
    let schema_too_new = located.is_none() && any_schema_too_new(paths);

    let (manifest_present, installed_version, install_directory, scope, installation_id, exe_present) =
        match &located {
            Some((_, m)) => {
                let exe_present = m
                    .primary_exe()
                    .map(|p| Path::new(p).exists())
                    .unwrap_or(false);
                (
                    true,
                    Some(m.version.clone()),
                    Some(m.install_directory.clone()),
                    Some(m.scope),
                    Some(m.installation_id.clone()),
                    exe_present,
                )
            }
            None => (false, None, None, None, None, false),
        };

    let inputs = DetectionInputs {
        manifest_present,
        exe_present,
        registry_present,
        registry_is_ours,
        installed_version: installed_version.clone(),
        wizard_version: wizard_version.to_string(),
        schema_too_new,
    };
    let state = assess(&inputs);
    tracing::info!(?state, ?installed_version, "detection resolved");

    Detection {
        state,
        installed_version,
        install_directory,
        scope,
        installation_id,
    }
}
