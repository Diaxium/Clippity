//! Startup recovery — act on an operation journal left behind by an
//! install / repair / update / uninstall that did not finish.
//!
//! On launch the wizard scans the maintenance directories for a leftover
//! [`installer_domain::journal::OperationJournal`]
//! ([`crate::detect::scan_pending_operation`]) and hands it here. The pure
//! [`installer_domain::journal::recover`] rule has already decided the
//! disposition; this module performs the safe, automatable ones — reversing
//! a half-applied operation, or clearing the leftovers of one that actually
//! finished — and reports the ones that need a human (resume a specific
//! plan, or manual recovery of an ambiguous state) rather than guessing.

use serde::{Deserialize, Serialize};

use installer_domain::journal::Recovery;
use installer_infra::error::InstallerResult;
use installer_infra::paths::InstallerPaths;

use crate::detect::{self, PendingOperation};
use crate::{journal_store, rollback};

/// What [`resolve_pending`] did (or is asking the caller to do) about a
/// discovered unfinished operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "kind", content = "detail")]
pub enum RecoveryOutcome {
    /// No unfinished operation was found.
    Nothing,
    /// A half-applied operation was reversed to its pre-operation state.
    RolledBack { reversed: usize },
    /// A finished operation's leftover journal/staging was cleared.
    Cleaned,
    /// The operation should be re-run from the start (its plan is not
    /// persisted, so the UI/CLI must re-drive it). Carries a human message.
    ResumeNeeded(String),
    /// The state is ambiguous; a human should resolve it. Carries a message.
    ManualRecovery(String),
}

/// Scan for an unfinished operation and resolve what can be resolved safely.
///
/// Automatable dispositions (roll back a partial operation, clean up a
/// finished one) are performed here. Non-automatable ones (resume a plan,
/// manual recovery) are returned for the caller to surface, because acting
/// on them without the user's intent could do the wrong thing.
pub fn resolve_pending(paths: &InstallerPaths) -> InstallerResult<RecoveryOutcome> {
    let Some(pending) = detect::scan_pending_operation(paths) else {
        return Ok(RecoveryOutcome::Nothing);
    };
    resolve(pending)
}

/// Resolve a specific discovered operation (split out for testing).
fn resolve(pending: PendingOperation) -> InstallerResult<RecoveryOutcome> {
    let PendingOperation {
        maintenance_dir,
        mut journal,
        recovery,
    } = pending;

    match recovery {
        Recovery::None => Ok(RecoveryOutcome::Nothing),

        // Reverse the applied actions, then drop the journal.
        Recovery::RollBack => {
            let reversed = rollback::roll_back(&maintenance_dir, &mut journal)?;
            journal_store::remove(&maintenance_dir)?;
            tracing::info!(reversed, "recovery: rolled back an unfinished operation");
            Ok(RecoveryOutcome::RolledBack { reversed })
        }

        // The operation finished; only leftovers remain — clear them.
        Recovery::Cleanup => {
            journal_store::remove(&maintenance_dir)?;
            tracing::info!("recovery: cleared a finished operation's leftovers");
            Ok(RecoveryOutcome::Cleaned)
        }

        // Roll-forward is only safe once the caller re-supplies the plan the
        // operation was running; surface it rather than fabricate one.
        Recovery::Resume => {
            let msg = format!(
                "A previous {:?} did not finish and should be run again.",
                journal.operation
            );
            tracing::warn!(op = ?journal.operation, "recovery: resume needed");
            Ok(RecoveryOutcome::ResumeNeeded(msg))
        }

        // Ambiguous (e.g. an unreadable journal schema) — never auto-act.
        Recovery::ManualRecovery => {
            let msg = format!(
                "A previous {:?} left the installation in a state that needs manual recovery.",
                journal.operation
            );
            tracing::error!(op = ?journal.operation, "recovery: manual recovery required");
            Ok(RecoveryOutcome::ManualRecovery(msg))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    use installer_domain::journal::{
        Action, ActionKind, JOURNAL_SCHEMA_VERSION, OperationJournal, OperationType, Phase,
    };

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("clippity-recovery-test-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pending(dir: std::path::PathBuf, journal: OperationJournal) -> PendingOperation {
        let recovery = installer_domain::journal::recover(&journal);
        PendingOperation {
            maintenance_dir: dir,
            journal,
            recovery,
        }
    }

    #[test]
    fn partial_install_is_rolled_back_and_journal_cleared() {
        let dir = temp_dir("rollback");
        let created = dir.join("Clippity.exe");
        fs::write(&created, b"partial").unwrap();

        // A journal that died mid-Apply having created one file.
        let mut j = OperationJournal::begin("op", OperationType::Install, "pid", "T0");
        j.advance(Phase::Apply, "T0");
        j.record_applied(Action::planned(0, ActionKind::CreateFile, created.to_string_lossy()), "T1");
        journal_store::write(&dir, &j).unwrap();

        let outcome = resolve(pending(dir.clone(), j)).unwrap();
        assert_eq!(outcome, RecoveryOutcome::RolledBack { reversed: 1 });
        assert!(!created.exists(), "the partially-created file was reversed");
        assert!(journal_store::read(&dir).unwrap().is_none(), "journal cleared");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn interrupted_before_apply_asks_for_resume() {
        let dir = temp_dir("resume");
        let mut j = OperationJournal::begin("op", OperationType::Update, "pid", "T0");
        j.advance(Phase::Plan, "T0");
        let outcome = resolve(pending(dir.clone(), j)).unwrap();
        assert!(matches!(outcome, RecoveryOutcome::ResumeNeeded(_)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_schema_needs_manual_recovery() {
        let dir = temp_dir("manual");
        let mut j = OperationJournal::begin("op", OperationType::Uninstall, "pid", "T0");
        j.schema_version = JOURNAL_SCHEMA_VERSION + 1;
        let outcome = resolve(pending(dir.clone(), j)).unwrap();
        assert!(matches!(outcome, RecoveryOutcome::ManualRecovery(_)));
        let _ = fs::remove_dir_all(&dir);
    }
}
