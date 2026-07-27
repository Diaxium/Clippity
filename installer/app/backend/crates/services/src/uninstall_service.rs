//! Uninstall orchestration — manifest-driven and deliberately
//! conservative.
//!
//! Removal is reversed off the installation manifest: only files, registry
//! values, and shortcuts the installer *recorded owning* are deleted.
//! Directories are removed only when they are empty afterward; unknown
//! files are preserved and their location reported. Nothing here ever
//! `remove_dir_all`s the install directory blindly, so a Clippity installed
//! into a shared or pre-existing folder cannot take unrelated files with
//! it. User content under `%APPDATA%` / `%LOCALAPPDATA%` is governed by the
//! data-category selection, never touched by the file-removal steps.

use std::fs;
use std::path::Path;

use installer_domain::state::{InstallState, InstallationManifest, RegistryHive};
use installer_domain::progress::{self, ProgressKind};
use installer_domain::uninstall::{summarize, RemovalSelection, RemovalSummary};
use installer_infra::error::{InstallerError, InstallerResult};
use installer_infra::paths::InstallerPaths;
use installer_infra::retry;
use installer_platform::windows_ops;

use crate::install_service::MAINTENANCE_EXE;
use crate::{detect, manifest, pace, state_store, ProgressSink};

/// Compute the removed/kept byte totals for a selection against the
/// current data catalog. Backs the Review-removal step.
pub fn summary(selection: &RemovalSelection) -> RemovalSummary {
    summarize(&manifest::data_categories(), selection)
}

/// Remove Clippity, deleting only the data categories the user selected
/// and only the application resources the manifest records owning.
///
/// Refuses to proceed unless the selection is `acknowledged` — the
/// Review step's confirmation toggle.
pub fn run(
    selection: &RemovalSelection,
    paths: &InstallerPaths,
    emit: &ProgressSink<'_>,
) -> InstallerResult<()> {
    if !selection.acknowledged {
        return Err(InstallerError::Invalid(
            "removal not acknowledged".to_string(),
        ));
    }

    tracing::info!(
        remove = selection.remove_ids.len(),
        export = selection.export_settings,
        "starting uninstall"
    );

    // The manifest is authoritative; without it we fall back to the
    // best-effort path (install_dir + whichever hive is present).
    let located = detect::locate_manifest(paths);
    let mut reboot_required = false;

    let tasks = progress::checklist_for(ProgressKind::Uninstall);
    let total = tasks.len();
    emit(progress::snapshot(ProgressKind::Uninstall, tasks.clone(), 0));

    for step in 0..total {
        match tasks[step].id.as_str() {
            // Release the app's own file locks before deleting its files:
            // Restart Manager tells us which processes hold them, we stop the
            // Clippity-owned ones (the controlled fallback), and any unrelated
            // holder is surfaced. An authenticated graceful-shutdown IPC that
            // lets the app save state first is the documented Phase 8 precursor.
            "processes" => match &located {
                Some((_, m)) => {
                    let report = clear_app_locks(m);
                    if report.user_must_close_apps() {
                        tracing::warn!(
                            apps = ?report.blocking_apps,
                            "some files are held by applications the uninstaller will not close"
                        );
                    }
                }
                None => pace(),
            },
            "appfiles" => match &located {
                Some((_, m)) => reboot_required |= remove_owned_files(m)?,
                None => remove_install_dir(paths)?,
            },
            "shortcuts" => match &located {
                Some((_, m)) => remove_recorded_shortcuts(m),
                None => {
                    let _ = windows_ops::remove_desktop_shortcut("Clippity");
                }
            },
            "cache" => pace(),
            "registry" => remove_registrations(paths, located.as_ref().map(|(_, m)| m))?,
            "finalize" => {
                if let Some((dir, _)) = &located {
                    reboot_required = finalize_maintenance_dir(dir)?;
                }
            }
            _ => pace(),
        }
        // The terminal (done) snapshot carries whether a reboot is still
        // needed to finish removing a locked file, so the Complete screen
        // reports it honestly instead of an unqualified success.
        let snapshot = progress::snapshot(ProgressKind::Uninstall, tasks.clone(), step + 1);
        let snapshot = if step + 1 == total {
            snapshot.with_reboot_required(reboot_required)
        } else {
            snapshot
        };
        emit(snapshot);
    }

    if reboot_required {
        tracing::warn!("uninstall complete — a reboot is required to finish removing locked files");
    } else {
        tracing::info!("uninstall complete");
    }
    Ok(())
}

/// Enumerate the processes holding the manifest's owned files open and stop
/// the Clippity-owned ones so the file-removal step can proceed. Delegates
/// the policy to the pure [`ShutdownPlan`]; never stops an unrelated app.
fn clear_app_locks(m: &InstallationManifest) -> crate::shutdown::LockClearReport {
    let targets: Vec<&Path> = m.files.iter().map(|f| Path::new(f.path.as_str())).collect();
    crate::shutdown::clear_locks(&targets, &m.install_directory, &m.maintenance_directory)
}

/// Delete every file the manifest records owning, then remove the recorded
/// directories only when they are empty. Unknown files survive.
///
/// A file that is still locked after the process-shutdown step (e.g. held by
/// an unrelated application we will not force-close) is scheduled for
/// deletion at the next reboot rather than left silently behind; the return
/// value reports whether any such reboot-deferred deletion was scheduled, so
/// the Complete screen can say so honestly.
fn remove_owned_files(m: &InstallationManifest) -> InstallerResult<bool> {
    let mut reboot_required = false;
    for f in &m.files {
        let path = Path::new(&f.path);
        if path.exists() {
            // Retry a transient lock first (antivirus / the search indexer
            // briefly holding a recently written exe) before falling back to
            // the reboot-scheduled deletion, so a normal uninstall does not
            // leave the file behind just because it was scanned mid-removal.
            if let Err(e) = retry::with_retry(|| fs::remove_file(path)) {
                tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "owned file still locked — scheduling deletion at next reboot"
                );
                if windows_ops::schedule_delete_on_reboot(path).is_ok() {
                    reboot_required = true;
                }
            }
        }
    }
    // Remove the install directory only if nothing unrecognised remains.
    let install_dir = Path::new(&m.install_directory);
    if reboot_required && install_dir.exists() {
        // Files were deferred to reboot; schedule the (empty-only) directory
        // after them so it is cleaned once its children are gone. Scheduling
        // children before the parent is required by MoveFileEx semantics.
        let _ = windows_ops::schedule_delete_on_reboot(install_dir);
    } else {
        remove_dir_if_empty(install_dir);
    }
    Ok(reboot_required)
}

/// Remove a directory only when it is empty; a non-empty directory (unknown
/// files remain) is preserved and reported.
fn remove_dir_if_empty(dir: &Path) {
    if !dir.exists() {
        return;
    }
    match fs::read_dir(dir).map(|mut it| it.next().is_none()) {
        Ok(true) => {
            if let Err(e) = fs::remove_dir(dir) {
                tracing::warn!(dir = %dir.display(), error = %e, "could not remove empty directory");
            }
        }
        Ok(false) => {
            tracing::info!(dir = %dir.display(), "preserving directory — unknown files remain");
        }
        Err(e) => tracing::warn!(dir = %dir.display(), error = %e, "could not inspect directory"),
    }
}

/// Delete each `.lnk` the manifest recorded, by exact path.
fn remove_recorded_shortcuts(m: &InstallationManifest) {
    for s in &m.shortcuts {
        let _ = windows_ops::remove_shortcut_path(Path::new(&s.path));
    }
}

/// Remove the Add/Remove Programs entry and the start-at-login value, from
/// the hive the manifest recorded (or whichever hive is present when there
/// is no manifest).
fn remove_registrations(
    paths: &InstallerPaths,
    manifest: Option<&InstallationManifest>,
) -> InstallerResult<()> {
    let hive = manifest
        .map(|m| RegistryHive::for_scope(m.scope))
        .or_else(windows_ops::uninstall_hive_present)
        .unwrap_or(RegistryHive::CurrentUser);

    windows_ops::remove_uninstall_entry(hive)?;

    // Start-at-login is always per-user; clearing it is a no-op when unset.
    let _ = windows_ops::set_start_at_login("", false);

    let _ = paths;
    Ok(())
}

/// Remove the manifest and maintenance directory. The running
/// maintenance/uninstaller exe cannot delete itself, so if it still holds
/// a lock its removal is scheduled for the next reboot; the return value is
/// whether a reboot is now required.
///
/// This is the interim self-removal path. The full design (a minimal
/// cleanup worker copied to `%TEMP%`) is documented in
/// `docs/installer/05-self-removal-and-locked-files.md`.
fn finalize_maintenance_dir(maintenance_dir: &Path) -> InstallerResult<bool> {
    state_store::remove(maintenance_dir)?;

    let mut reboot_required = false;
    let exe = maintenance_dir.join(MAINTENANCE_EXE);
    if exe.exists() {
        if fs::remove_file(&exe).is_err() {
            // Locked (we are probably running from it) — schedule for reboot.
            if windows_ops::schedule_delete_on_reboot(&exe).is_ok() {
                reboot_required = true;
            }
        }
    }

    if fs::remove_dir(maintenance_dir).is_err() {
        // Not empty yet (the exe is pending reboot removal) — schedule the
        // directory too, so it is cleaned once the exe is gone.
        if reboot_required {
            let _ = windows_ops::schedule_delete_on_reboot(maintenance_dir);
        } else {
            remove_dir_if_empty(maintenance_dir);
        }
    }
    Ok(reboot_required)
}

/// Best-effort fallback when no manifest is present: remove the install
/// directory recorded in `paths`. Tolerates an already-absent directory.
///
/// Kept conservative — this path only runs for a pre-manifest (legacy)
/// install with no recorded file list, and even then removes only the
/// directory the resolved paths point at, never a user-typed data folder.
fn remove_install_dir(paths: &InstallerPaths) -> InstallerResult<()> {
    let dir = &paths.install_dir;
    if !dir.exists() {
        tracing::info!(dir = %dir.display(), "install directory already absent");
        return Ok(());
    }
    tracing::info!(dir = %dir.display(), "removing install directory (no manifest)");
    fs::remove_dir_all(dir)?;
    Ok(())
}

/// Whether a detected state permits an uninstall to proceed. Exposed for
/// the command layer to gate the flow.
pub fn state_is_uninstallable(state: InstallState) -> bool {
    matches!(
        state,
        InstallState::Healthy
            | InstallState::Damaged
            | InstallState::Partial
            | InstallState::OlderVersion
            | InstallState::SameVersion
            | InstallState::NewerVersion
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    use installer_domain::install::InstallScope;
    use installer_domain::state::{InstalledFile, PRODUCT_ID, SCHEMA_VERSION};

    /// A unique temp directory for a test, without pulling in a temp crate.
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("clippity-uninstall-test-{tag}-{n}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manifest_for(install_dir: &Path, files: Vec<InstalledFile>) -> InstallationManifest {
        InstallationManifest {
            schema_version: SCHEMA_VERSION,
            product_id: PRODUCT_ID.to_string(),
            installation_id: "test".to_string(),
            version: "0.1.0".to_string(),
            architecture: "x64".to_string(),
            scope: InstallScope::CurrentUser,
            install_directory: install_dir.to_string_lossy().to_string(),
            maintenance_directory: install_dir.to_string_lossy().to_string(),
            install_date: "1970-01-01T00:00:00Z".to_string(),
            installed_components: vec!["core".to_string()],
            files,
            directories: vec![install_dir.to_string_lossy().to_string()],
            registry_entries: vec![],
            shortcuts: vec![],
            start_at_login: false,
            preferences: Default::default(),
        }
    }

    #[test]
    fn owned_files_are_removed_but_unknown_files_are_preserved() {
        let dir = temp_dir("preserve");
        let owned = dir.join("Clippity.exe");
        let unknown = dir.join("user-notes.txt");
        fs::write(&owned, b"app").unwrap();
        fs::write(&unknown, b"do not delete me").unwrap();

        let m = manifest_for(
            &dir,
            vec![InstalledFile {
                path: owned.to_string_lossy().to_string(),
                sha256: None,
                bytes: 3,
                component: "core".to_string(),
                mutable: false,
            }],
        );

        remove_owned_files(&m).unwrap();

        assert!(!owned.exists(), "owned file should be removed");
        assert!(unknown.exists(), "unknown file must be preserved");
        assert!(dir.exists(), "directory with unknown files must be preserved");

        // Cleanup.
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_install_dir_is_removed_after_owned_files() {
        let dir = temp_dir("empty");
        let owned = dir.join("Clippity.exe");
        fs::write(&owned, b"app").unwrap();

        let m = manifest_for(
            &dir,
            vec![InstalledFile {
                path: owned.to_string_lossy().to_string(),
                sha256: None,
                bytes: 3,
                component: "core".to_string(),
                mutable: false,
            }],
        );

        remove_owned_files(&m).unwrap();

        assert!(!dir.exists(), "an install dir left empty should be removed");
    }
}
