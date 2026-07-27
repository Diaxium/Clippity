//! Persist and read the operation journal (`operation.json`) alongside the
//! installation manifest in the maintenance directory.
//!
//! While a mutating operation runs, its
//! [`installer_domain::journal::OperationJournal`] is flushed here after
//! every phase change and recorded action, so a crash leaves a truthful
//! record. On the next launch [`scan`] reads it back and the pure
//! [`installer_domain::journal::recover`] rule decides what to do with a
//! half-finished operation. On a clean commit + cleanup the file is
//! removed, so its mere presence means "an operation did not finish".

use std::fs;
use std::path::{Path, PathBuf};

use installer_domain::journal::OperationJournal;
use installer_infra::error::{other, InstallerResult};

/// File name of the on-disk journal inside the maintenance directory.
pub const JOURNAL_FILE: &str = "operation.json";

/// Absolute path of the journal under a maintenance directory.
pub fn journal_path(maintenance_dir: &Path) -> PathBuf {
    maintenance_dir.join(JOURNAL_FILE)
}

/// Flush the journal as pretty JSON, creating the maintenance dir. Called
/// after each phase advance and recorded action, so the on-disk record
/// never lags the live one by more than the action in flight.
pub fn write(maintenance_dir: &Path, journal: &OperationJournal) -> InstallerResult<()> {
    fs::create_dir_all(maintenance_dir)?;
    let json = serde_json::to_string_pretty(journal)
        .map_err(|e| other(format!("could not serialize the operation journal: {e}")))?;
    fs::write(journal_path(maintenance_dir), json)?;
    Ok(())
}

/// Read the journal back. `Ok(None)` when absent (the normal, no-operation-
/// in-flight case); `Err` when it exists but cannot be parsed.
pub fn read(maintenance_dir: &Path) -> InstallerResult<Option<OperationJournal>> {
    let path = journal_path(maintenance_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    let journal: OperationJournal = serde_json::from_str(&raw)
        .map_err(|e| other(format!("the operation journal is unreadable: {e}")))?;
    Ok(Some(journal))
}

/// Remove the journal file — the last step of a committed-and-cleaned or a
/// fully-rolled-back operation. A missing file is success.
pub fn remove(maintenance_dir: &Path) -> InstallerResult<()> {
    let path = journal_path(maintenance_dir);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    use installer_domain::journal::{OperationJournal, OperationType, Phase};

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("clippity-journal-test-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = temp_dir("rt");
        let mut j = OperationJournal::begin("op-1", OperationType::Repair, "com.clippity.app", "T0");
        j.advance(Phase::Apply, "T1");
        write(&dir, &j).unwrap();

        let back = read(&dir).unwrap().expect("journal present");
        assert_eq!(back.operation, OperationType::Repair);
        assert_eq!(back.phase, Phase::Apply);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn absent_journal_is_ok_none() {
        let dir = temp_dir("absent");
        assert!(read(&dir).unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_clears_the_record() {
        let dir = temp_dir("rm");
        let j = OperationJournal::begin("op-1", OperationType::Uninstall, "com.clippity.app", "T0");
        write(&dir, &j).unwrap();
        assert!(read(&dir).unwrap().is_some());
        remove(&dir).unwrap();
        assert!(read(&dir).unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
