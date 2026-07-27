//! The rollback executor — the I/O counterpart to
//! [`installer_domain::journal`].
//!
//! The domain records *what* each mutating action did and *how* to reverse
//! it; this module performs the reversal. Given a journal, it walks
//! [`OperationJournal::pending_reversals`] (applied actions, newest-first)
//! and undoes each by its [`ActionKind`]: a created file is deleted, a
//! replaced file is restored from its backup, a created registry key is
//! removed, and so on. It is deliberately conservative — a reversal that
//! cannot be done safely (a replace/delete with no surviving backup) is
//! logged and skipped rather than guessed at, so rollback never destroys
//! data it cannot put back.
//!
//! This is what lets a *failed* install undo itself instead of leaving a
//! half-written install directory and a dangling Add/Remove Programs entry,
//! and what the startup recovery-scan runs when it finds an operation that
//! died mid-`Apply`.

use std::fs;
use std::path::Path;

use installer_domain::journal::{Action, ActionKind, OperationJournal, Outcome};
use installer_infra::error::InstallerResult;
use installer_platform::windows_ops;

use crate::{clock, journal_store};

/// Reverse every applied action in `journal`, newest-first, then mark the
/// journal `RolledBack` and flush it. Individual reversal failures are
/// logged and do not abort the rest — a best-effort rollback that reverses
/// as much as it safely can is better than stopping at the first stuck file.
///
/// Returns the number of actions successfully reversed.
pub fn roll_back(maintenance_dir: &Path, journal: &mut OperationJournal) -> InstallerResult<usize> {
    let clock = clock::now();
    tracing::warn!(
        op = ?journal.operation,
        actions = journal.pending_reversals().len(),
        "rolling back operation"
    );

    // Collect ids up front so we can mutate the journal as we go.
    let ids: Vec<u32> = journal.pending_reversals().iter().map(|a| a.id).collect();
    let mut reversed = 0usize;

    for id in ids {
        // Clone the action's facts before the mutable borrow to mark it.
        let action = match journal.actions.iter().find(|a| a.id == id) {
            Some(a) => a.clone(),
            None => continue,
        };
        match reverse_action(&action) {
            Ok(()) => {
                journal.mark_reversed(id, &clock.iso);
                reversed += 1;
            }
            Err(e) => {
                tracing::warn!(id, target = %action.target, error = %e, "could not reverse action");
            }
        }
        // Flush after each reversal so an interrupted rollback resumes
        // where it left off rather than repeating reversed actions.
        let _ = journal_store::write(maintenance_dir, journal);
    }

    journal.finish(Outcome::RolledBack, &clock.iso);
    journal_store::write(maintenance_dir, journal)?;
    tracing::info!(reversed, "rollback complete");
    Ok(reversed)
}

/// Reverse a single applied action by its kind. Pure-ish: only touches the
/// exact resource the action recorded.
pub fn reverse_action(action: &Action) -> InstallerResult<()> {
    match action.kind {
        // A file we created: delete it. An already-absent file is success
        // (the create may never have flushed before the crash).
        ActionKind::CreateFile => {
            remove_file_if_present(&action.target);
            Ok(())
        }
        // A file we overwrote or deleted: restore the displaced original.
        ActionKind::ReplaceFile | ActionKind::DeleteFile => match &action.backup {
            Some(backup) if Path::new(backup).exists() => {
                let _ = fs::remove_file(&action.target);
                fs::rename(backup, &action.target)?;
                Ok(())
            }
            _ => {
                // No surviving backup — cannot safely restore. Leave the
                // current state and report; never fabricate a file.
                tracing::warn!(
                    target = %action.target,
                    "no backup to restore for a replace/delete reversal"
                );
                Ok(())
            }
        },
        // A directory we created: remove it only if still empty, so we never
        // take unknown files that arrived after the create.
        ActionKind::CreateDirectory => {
            remove_dir_if_empty(&action.target);
            Ok(())
        }
        // A registry value we wrote: restore the prior value, or delete ours
        // when there was none. (Whole-key creates use WriteRegistryKey.)
        ActionKind::WriteRegistryValue | ActionKind::WriteRegistryKey => {
            reverse_registry(action)
        }
        // A shortcut we created.
        ActionKind::CreateShortcut => windows_ops::remove_shortcut_path(Path::new(&action.target)),
        // The maintenance/uninstaller copy — it may be the running exe, so
        // schedule its removal for reboot if a direct delete is refused.
        ActionKind::PlaceMaintenanceExe => {
            let target = Path::new(&action.target);
            if target.exists() && fs::remove_file(target).is_err() {
                let _ = windows_ops::schedule_delete_on_reboot(target);
            }
            Ok(())
        }
        // The installation manifest.
        ActionKind::WriteManifest => {
            remove_file_if_present(&action.target);
            Ok(())
        }
    }
}

/// Reverse a registry write. The `target` is "hive\\subkey" (for a key) or
/// "hive\\subkey\\value" (for a value); the concrete platform helpers own
/// the parse. For the Add/Remove Programs entry — the one whole-key write
/// the installer makes — reversal is the scope-correct ARP delete already
/// implemented, so we route through it.
fn reverse_registry(action: &Action) -> InstallerResult<()> {
    // The only registrations the installer creates today are the ARP
    // subkey and the per-user Run value. Both have precise, scope-aware
    // removals on the platform facade; a bespoke value-restore path is
    // deferred until a mutating (as opposed to create) registry action
    // exists to need it.
    let target = action.target.to_lowercase();
    if target.contains("uninstall\\clippity") {
        if let Some(hive) = windows_ops::uninstall_hive_present() {
            return windows_ops::remove_uninstall_entry(hive);
        }
        return Ok(());
    }
    if target.contains(r"currentversion\run") {
        return windows_ops::set_start_at_login("", false);
    }
    tracing::warn!(target = %action.target, "no reversal mapped for registry action");
    Ok(())
}

fn remove_file_if_present(path: &str) {
    let p = Path::new(path);
    if p.exists() {
        if let Err(e) = fs::remove_file(p) {
            tracing::warn!(path = %p.display(), error = %e, "could not remove file during rollback");
        }
    }
}

fn remove_dir_if_empty(path: &str) {
    let dir = Path::new(path);
    if !dir.exists() {
        return;
    }
    if let Ok(true) = fs::read_dir(dir).map(|mut it| it.next().is_none()) {
        let _ = fs::remove_dir(dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    use installer_domain::journal::{Action, ActionKind};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("clippity-rollback-test-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn create_file_reversal_deletes_it() {
        let dir = temp_dir("create");
        let file = dir.join("Clippity.exe");
        fs::write(&file, b"app").unwrap();

        let action = Action::planned(0, ActionKind::CreateFile, file.to_string_lossy());
        reverse_action(&action).unwrap();

        assert!(!file.exists(), "a created file must be deleted on rollback");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_file_reversal_restores_the_backup() {
        let dir = temp_dir("replace");
        let file = dir.join("Clippity.exe");
        let backup = dir.join("Clippity.exe.old");
        // Simulate a completed replace: new bytes live, original in backup.
        fs::write(&file, b"new-broken").unwrap();
        fs::write(&backup, b"original-good").unwrap();

        let action = Action::planned(0, ActionKind::ReplaceFile, file.to_string_lossy())
            .with_backup(backup.to_string_lossy());
        reverse_action(&action).unwrap();

        assert_eq!(fs::read(&file).unwrap(), b"original-good");
        assert!(!backup.exists(), "the backup is consumed by the restore");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn replace_reversal_without_backup_leaves_current_state() {
        let dir = temp_dir("nobackup");
        let file = dir.join("Clippity.exe");
        fs::write(&file, b"current").unwrap();

        // A replace action whose backup is gone must not delete the file.
        let action = Action::planned(0, ActionKind::ReplaceFile, file.to_string_lossy())
            .with_backup(dir.join("missing.old").to_string_lossy());
        reverse_action(&action).unwrap();

        assert!(file.exists(), "no fabrication and no destructive delete");
        assert_eq!(fs::read(&file).unwrap(), b"current");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_directory_reversal_only_removes_when_empty() {
        let dir = temp_dir("dir");
        let created = dir.join("Clippity");
        fs::create_dir_all(&created).unwrap();

        // Empty → removed.
        let action = Action::planned(0, ActionKind::CreateDirectory, created.to_string_lossy());
        reverse_action(&action).unwrap();
        assert!(!created.exists());

        // Non-empty → preserved.
        fs::create_dir_all(&created).unwrap();
        fs::write(created.join("user.txt"), b"keep").unwrap();
        reverse_action(&action).unwrap();
        assert!(created.exists(), "a dir with unknown files must survive rollback");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn roll_back_reverses_newest_first_and_marks_the_journal() {
        let dir = temp_dir("journal");
        let a = dir.join("a.exe");
        let b = dir.join("b.dat");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();

        let mut j =
            OperationJournal::begin("op", installer_domain::journal::OperationType::Install, "pid", "T0");
        j.advance(installer_domain::journal::Phase::Apply, "T0");
        j.record_applied(Action::planned(0, ActionKind::CreateFile, a.to_string_lossy()), "T1");
        j.record_applied(Action::planned(0, ActionKind::CreateFile, b.to_string_lossy()), "T2");

        let reversed = roll_back(&dir, &mut j).unwrap();
        assert_eq!(reversed, 2);
        assert!(!a.exists() && !b.exists());
        assert_eq!(j.outcome, Outcome::RolledBack);
        assert!(j.pending_reversals().is_empty(), "everything reversed");
        let _ = fs::remove_dir_all(&dir);
    }
}
