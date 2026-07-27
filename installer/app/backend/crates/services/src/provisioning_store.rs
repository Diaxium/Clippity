//! Write the installer → application handoff document
//! ([`installer_domain::provisioning`]) into the install directory.
//!
//! The seam between the in-memory [`AppProvisioning`] and the
//! `install-config.json` the application reads at startup. Install and
//! modify write it (both go through `install_service::run`), repair
//! restores it, and uninstall removes it as one of the manifest's owned
//! files — nothing here has to know about that last part, which is the
//! point of recording it in the manifest rather than special-casing it.
//!
//! Pretty-printed on purpose: a user who wonders why Grab Text is missing
//! can open the file beside `Clippity.exe` and read the answer.

use std::fs;
use std::path::{Path, PathBuf};

use installer_domain::provisioning::{AppProvisioning, PROVISIONING_FILE};
use installer_domain::state::InstallationManifest;
use installer_infra::error::{other, InstallerResult};
use installer_infra::retry;

/// Absolute path of the handoff document inside an install directory.
pub fn provisioning_path(install_dir: &Path) -> PathBuf {
    install_dir.join(PROVISIONING_FILE)
}

/// Serialize `doc` into `install_dir`, returning the path written.
///
/// Retried like every other write under the install directory: a freshly
/// created file there is briefly held by antivirus and the search indexer,
/// so a first attempt can fail transiently on a machine that is otherwise
/// perfectly healthy (see `payload::install_to`).
pub fn write(install_dir: &Path, doc: &AppProvisioning) -> InstallerResult<PathBuf> {
    retry::with_retry(|| fs::create_dir_all(install_dir))?;
    let path = provisioning_path(install_dir);
    let json = serde_json::to_string_pretty(doc)
        .map_err(|e| other(format!("could not serialize the app configuration: {e}")))?;
    retry::with_retry(|| fs::write(&path, json.as_bytes()))?;
    tracing::info!(
        path = %path.display(),
        components = doc.components.len(),
        "wrote application configuration"
    );
    Ok(path)
}

/// Write the document implied by a committed manifest.
///
/// The one-call form used by install and repair alike, so the two can't
/// drift into composing the document differently.
pub fn write_from_manifest(
    install_dir: &Path,
    manifest: &InstallationManifest,
) -> InstallerResult<PathBuf> {
    write(install_dir, &AppProvisioning::from_manifest(manifest))
}

/// Read the document back. `Ok(None)` when absent or unparseable.
///
/// Unlike the manifest, a corrupt handoff document is *not* an error worth
/// failing an operation over: it is derived state that the next write
/// replaces wholesale. Repair uses this to decide whether to rewrite it,
/// and "unreadable" and "missing" both mean the same thing there.
pub fn read(install_dir: &Path) -> InstallerResult<Option<AppProvisioning>> {
    let path = provisioning_path(install_dir);
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    match serde_json::from_str::<AppProvisioning>(&raw) {
        Ok(doc) => Ok(Some(doc)),
        Err(e) => {
            tracing::warn!(
                path = %path.display(),
                error = %e,
                "application configuration is unreadable — it will be rewritten"
            );
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    use installer_domain::install::{InstallPreferences, InstallScope};
    use installer_domain::state::{InstalledFile, PRODUCT_ID, SCHEMA_VERSION};

    static N: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(tag: &str) -> PathBuf {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("clippity-provisioning-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manifest(install_dir: &Path) -> InstallationManifest {
        InstallationManifest {
            schema_version: SCHEMA_VERSION,
            product_id: PRODUCT_ID.to_string(),
            installation_id: "test".into(),
            version: "1.5.0".into(),
            architecture: "x64".into(),
            scope: InstallScope::CurrentUser,
            install_directory: install_dir.to_string_lossy().to_string(),
            maintenance_directory: install_dir.to_string_lossy().to_string(),
            install_date: "2026-07-25T10:00:00Z".into(),
            installed_components: vec!["core".into(), "ocr".into()],
            files: vec![InstalledFile {
                path: install_dir.join("Clippity.exe").to_string_lossy().to_string(),
                sha256: None,
                bytes: 1,
                component: "core".into(),
                mutable: false,
            }],
            directories: vec![],
            registry_entries: vec![],
            shortcuts: vec![],
            start_at_login: false,
            preferences: InstallPreferences {
                automatic_updates: false,
                help_improve: false,
                file_associations: true,
            },
        }
    }

    #[test]
    fn write_then_read_round_trips_the_document() {
        let dir = temp_dir("round-trip");
        let m = manifest(&dir);
        let path = write_from_manifest(&dir, &m).unwrap();
        assert_eq!(path, dir.join(PROVISIONING_FILE));

        let back = read(&dir).unwrap().expect("document present");
        assert_eq!(back.components, vec!["core", "ocr"]);
        assert!(!back.preferences.automatic_updates);
        assert!(!back.preferences.help_improve);
        assert!(back.preferences.file_associations);
    }

    #[test]
    fn a_missing_document_reads_as_none() {
        let dir = temp_dir("absent");
        assert!(read(&dir).unwrap().is_none());
    }

    #[test]
    fn a_corrupt_document_reads_as_none_rather_than_failing() {
        // Derived state: the next write replaces it wholesale, so refusing
        // to repair over garbage would strand the install for no reason.
        let dir = temp_dir("corrupt");
        fs::write(provisioning_path(&dir), "{ not json").unwrap();
        assert!(read(&dir).unwrap().is_none());
    }

    #[test]
    fn the_written_file_is_readable_by_hand() {
        let dir = temp_dir("pretty");
        let m = manifest(&dir);
        write_from_manifest(&dir, &m).unwrap();
        let raw = fs::read_to_string(provisioning_path(&dir)).unwrap();
        assert!(raw.contains('\n'), "expected pretty-printed JSON: {raw}");
        assert!(raw.contains("\"components\""), "{raw}");
    }
}
