//! Repair assessment — the pure rules that decide what a repair must
//! restore, given the installation manifest and what was found on disk.
//!
//! Repair's contract is narrow and safety-critical: it restores
//! *installer-owned, immutable* resources to the state the manifest
//! records, and it never touches user data or files the app legitimately
//! rewrites. The classification here is pure so it is unit-testable without
//! a filesystem; the [`crate::state::InstalledFile`] facts plus a probe of
//! the live disk are handed in, and this decides which files are healthy,
//! missing, or corrupt.

use serde::{Deserialize, Serialize};

use crate::state::InstalledFile;

/// The health of one installed file, as judged by [`assess_file`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileHealth {
    /// Present and (for an immutable file with a recorded hash) matching.
    Ok,
    /// An immutable, installer-owned file that is not on disk.
    Missing,
    /// Present but its bytes no longer match the recorded hash.
    Corrupt,
}

/// A live probe of one manifest-recorded file: does it exist, and (when we
/// bothered to hash it) what is its current digest.
#[derive(Debug, Clone)]
pub struct FileProbe {
    pub present: bool,
    /// The file's current SHA-256 (lowercase hex), if it was hashed. `None`
    /// when absent or when hashing was skipped (e.g. a mutable file).
    pub actual_sha256: Option<String>,
}

/// Classify a single file from its manifest record and a live probe.
///
/// A **mutable** file — one the app rewrites at runtime — is always
/// reported `Ok`: repair must not fight the application over its own data,
/// and such a file's contents legitimately diverge from install time. Only
/// immutable, installer-owned files are candidates for restore.
pub fn assess_file(record: &InstalledFile, probe: &FileProbe) -> FileHealth {
    if record.mutable {
        return FileHealth::Ok;
    }
    if !probe.present {
        return FileHealth::Missing;
    }
    match (&record.sha256, &probe.actual_sha256) {
        // Both hashes known: a mismatch is corruption.
        (Some(expected), Some(actual)) if !expected.eq_ignore_ascii_case(actual) => {
            FileHealth::Corrupt
        }
        // Present, and either matching or unhashed: healthy.
        _ => FileHealth::Ok,
    }
}

/// One file that repair needs to act on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIssue {
    pub path: String,
    pub component: String,
    pub health: FileHealth,
}

/// The full outcome of a repair scan: which files are broken, and whether
/// the Windows integrations (shortcuts, registry) need re-registering.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairAssessment {
    /// Files that are missing or corrupt (healthy files are omitted).
    pub issues: Vec<FileIssue>,
    /// Recorded shortcut `.lnk` paths that are no longer on disk.
    pub missing_shortcuts: Vec<String>,
    /// The Add/Remove Programs registration is absent and must be rewritten.
    pub registry_missing: bool,
}

impl RepairAssessment {
    /// Whether the scan found anything to repair.
    pub fn needs_repair(&self) -> bool {
        !self.issues.is_empty() || !self.missing_shortcuts.is_empty() || self.registry_missing
    }

    /// Files that are missing (as opposed to corrupt) — the ones a restore
    /// re-creates from scratch.
    pub fn missing_files(&self) -> impl Iterator<Item = &FileIssue> {
        self.issues.iter().filter(|i| i.health == FileHealth::Missing)
    }

    /// Whether the core application executable itself is broken — the one
    /// case a repair can always fix from the embedded payload.
    pub fn core_is_broken(&self) -> bool {
        self.issues.iter().any(|i| i.component == "core")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(mutable: bool, sha: Option<&str>) -> InstalledFile {
        InstalledFile {
            path: r"C:\Program Files\Clippity\Clippity.exe".into(),
            sha256: sha.map(|s| s.to_string()),
            bytes: 100,
            component: "core".into(),
            mutable,
        }
    }

    #[test]
    fn missing_immutable_file_is_missing() {
        let r = record(false, Some("abc"));
        let p = FileProbe { present: false, actual_sha256: None };
        assert_eq!(assess_file(&r, &p), FileHealth::Missing);
    }

    #[test]
    fn hash_mismatch_is_corrupt() {
        let r = record(false, Some("expected"));
        let p = FileProbe { present: true, actual_sha256: Some("different".into()) };
        assert_eq!(assess_file(&r, &p), FileHealth::Corrupt);
    }

    #[test]
    fn matching_hash_is_ok_case_insensitive() {
        let r = record(false, Some("ABCDEF"));
        let p = FileProbe { present: true, actual_sha256: Some("abcdef".into()) };
        assert_eq!(assess_file(&r, &p), FileHealth::Ok);
    }

    #[test]
    fn mutable_file_is_never_repaired() {
        // Missing and hash-mismatched, but mutable → still Ok, because the
        // app owns its runtime data and repair must not overwrite it.
        let r = record(true, Some("expected"));
        let missing = FileProbe { present: false, actual_sha256: None };
        let changed = FileProbe { present: true, actual_sha256: Some("changed".into()) };
        assert_eq!(assess_file(&r, &missing), FileHealth::Ok);
        assert_eq!(assess_file(&r, &changed), FileHealth::Ok);
    }

    #[test]
    fn present_unhashed_immutable_is_ok() {
        let r = record(false, None);
        let p = FileProbe { present: true, actual_sha256: None };
        assert_eq!(assess_file(&r, &p), FileHealth::Ok);
    }

    #[test]
    fn assessment_reports_and_summarizes() {
        let mut a = RepairAssessment::default();
        assert!(!a.needs_repair());

        a.issues.push(FileIssue {
            path: r"C:\Program Files\Clippity\Clippity.exe".into(),
            component: "core".into(),
            health: FileHealth::Missing,
        });
        a.missing_shortcuts.push(r"C:\Users\Sam\Desktop\Clippity.lnk".into());
        a.registry_missing = true;

        assert!(a.needs_repair());
        assert!(a.core_is_broken());
        assert_eq!(a.missing_files().count(), 1);
    }
}
