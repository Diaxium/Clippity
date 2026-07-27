//! Repair orchestration — restore an installed copy to health without
//! upgrading it or touching user data.
//!
//! Repair reads the installation manifest, probes every installer-owned
//! immutable file (existence + SHA-256), and restores what is missing or
//! corrupt: the core application executable from the embedded payload,
//! recorded shortcuts that vanished, and the Add/Remove Programs
//! registration if it was removed. It restores the *installed* version —
//! never a silent upgrade — and never rewrites files the app owns at
//! runtime, and never removes user content. Every step is recorded in an
//! [`OperationJournal`] so a crashed repair is detected (and safely
//! re-runnable) on the next launch.

use std::path::Path;

use sha2::{Digest, Sha256};

use installer_domain::journal::{
    Action, ActionKind, OperationJournal, OperationType, Outcome, Phase,
};
use installer_domain::progress::{self, ProgressKind};
use installer_domain::provisioning::{self, AppProvisioning};
use installer_domain::repair::{assess_file, FileHealth, FileIssue, FileProbe, RepairAssessment};
use installer_domain::state::InstallationManifest;
use installer_domain::wizard::ProductInfo;
use installer_infra::error::{other, InstallerError, InstallerResult};
use installer_infra::paths::InstallerPaths;
use installer_platform::entry::UninstallEntry;
use installer_platform::windows_ops;

use crate::install_service::MAINTENANCE_EXE;
use crate::payload::Payload;
use crate::{clock, detect, journal_store, pace, provisioning_store, ProgressSink};

/// Scan an installed copy and report what (if anything) needs repair,
/// without changing anything. Backs a "Repair recommended" hub badge and
/// the pre-repair review.
pub fn assess(paths: &InstallerPaths) -> InstallerResult<RepairAssessment> {
    let (_, manifest) = detect::locate_manifest(paths)
        .ok_or_else(|| InstallerError::Invalid("nothing is installed to repair".into()))?;
    Ok(scan(&manifest))
}

/// Probe the live system against the manifest and build a
/// [`RepairAssessment`]. Pure classification is delegated to
/// [`installer_domain::repair::assess_file`]; this only performs the I/O
/// (existence checks, hashing) that feeds it.
fn scan(manifest: &InstallationManifest) -> RepairAssessment {
    let mut assessment = RepairAssessment::default();

    for record in &manifest.files {
        let path = Path::new(&record.path);
        let present = path.exists();
        // Only hash an immutable file that both exists and has a recorded
        // hash — the sole case where a digest tells us anything.
        let actual = if present && !record.mutable && record.sha256.is_some() {
            file_sha256(path).ok()
        } else {
            None
        };
        let probe = FileProbe {
            present,
            actual_sha256: actual,
        };
        let health = assess_file(record, &probe);
        if health != FileHealth::Ok {
            assessment.issues.push(FileIssue {
                path: record.path.clone(),
                component: record.component.clone(),
                health,
            });
        }
    }

    for s in &manifest.shortcuts {
        if !Path::new(&s.path).exists() {
            assessment.missing_shortcuts.push(s.path.clone());
        }
    }

    // The registration is "missing" when no Uninstall\Clippity key exists in
    // any hive. (A present-but-foreign entry is a detection concern, not a
    // repair one.)
    assessment.registry_missing = windows_ops::uninstall_hive_present().is_none();

    assessment
}

/// Run a full repair, emitting progress along the repair checklist.
///
/// `product` supplies the publisher/URL facts for a re-written ARP entry;
/// the *version* restored is always the manifest's, never this build's, so
/// repair cannot become a covert upgrade.
pub fn run(
    product: &ProductInfo,
    paths: &InstallerPaths,
    payload: &Payload,
    emit: &ProgressSink<'_>,
) -> InstallerResult<()> {
    let clock = clock::now();
    let (maintenance_dir, manifest) = detect::locate_manifest(paths)
        .ok_or_else(|| InstallerError::Invalid("nothing is installed to repair".into()))?;

    tracing::info!(version = %manifest.version, "starting repair");

    let mut journal = OperationJournal::begin(
        format!("repair-{}", clock.compact),
        OperationType::Repair,
        manifest.product_id.clone(),
        clock.iso.clone(),
    );
    journal.installation_id = Some(manifest.installation_id.clone());
    journal.to_version = Some(manifest.version.clone());
    let _ = journal_store::write(&maintenance_dir, &journal);

    let tasks = progress::checklist_for(ProgressKind::Repair);
    let total = tasks.len();
    emit(progress::snapshot(ProgressKind::Repair, tasks.clone(), 0));

    // Run the repair, capturing any error so the journal records the
    // failure (repair is restorative — a failed repair is re-run, not
    // rolled back, so we do not reverse the partial restore).
    let result = (|| -> InstallerResult<()> {
        for step in 0..total {
            match tasks[step].id.as_str() {
                "scan" => {
                    journal.advance(Phase::Detect, &clock.iso);
                    let _ = journal_store::write(&maintenance_dir, &journal);
                }
                "verify" => {
                    journal.advance(Phase::Validate, &clock.iso);
                    payload.verify()?; // the restore source must itself be sound
                    let _ = journal_store::write(&maintenance_dir, &journal);
                }
                "restore" => {
                    journal.advance(Phase::Apply, &clock.iso);
                    restore_files(&manifest, payload, &mut journal, &maintenance_dir, &clock)?;
                    // Reconciled outside `restore_files` — and so outside its
                    // "nothing is broken, return early" guard — because this
                    // document is regenerated from the manifest rather than
                    // hash-verified against it. A hand-edited copy that
                    // re-enables a declined feature reads as perfectly
                    // healthy to the scan; repair is the thing that should
                    // put it back.
                    restore_app_configuration(
                        &manifest,
                        &mut journal,
                        &maintenance_dir,
                        &clock,
                    );
                }
                "integrations" => {
                    restore_integrations(
                        &manifest,
                        product,
                        paths,
                        &mut journal,
                        &maintenance_dir,
                        &clock,
                    )?;
                }
                "finalize" => {
                    journal.advance(Phase::Commit, &clock.iso);
                    let _ = journal_store::write(&maintenance_dir, &journal);
                }
                _ => pace(),
            }
            emit(progress::snapshot(ProgressKind::Repair, tasks.clone(), step + 1));
        }
        Ok(())
    })();

    match result {
        Ok(()) => {
            journal.advance(Phase::Cleanup, &clock.iso);
            journal.finish(Outcome::Committed, &clock.iso);
            let _ = journal_store::write(&maintenance_dir, &journal);
            // A clean repair leaves no in-flight journal behind.
            let _ = journal_store::remove(&maintenance_dir);
            // When repair replaced a corrupt exe, `install_to` moved the bad
            // copy to `<exe>.old`; drop it so the install dir is left clean
            // (and a later uninstall can remove the now-empty directory).
            clean_repair_backup(&manifest);
            tracing::info!("repair complete");
            Ok(())
        }
        Err(e) => {
            journal.fail(e.to_string(), &clock.iso);
            let _ = journal_store::write(&maintenance_dir, &journal);
            tracing::error!(error = %e, "repair failed — the journal records it for re-run");
            Err(e)
        }
    }
}

/// Restore broken files. The core executable is re-written from the
/// embedded payload; other components live in the same monolithic payload
/// and are restored with it, so a broken non-core file is repaired by
/// restoring core and reported when it cannot be addressed independently.
fn restore_files(
    manifest: &InstallationManifest,
    payload: &Payload,
    journal: &mut OperationJournal,
    maintenance_dir: &Path,
    clock: &clock::Utc,
) -> InstallerResult<()> {
    let assessment = scan(manifest);
    if !assessment.needs_repair() {
        tracing::info!("repair: nothing to restore — installation is healthy");
        return Ok(());
    }

    // Restore the core executable if it (or the payload it lives in) is
    // broken. `install_to` writes the payload's exe into the install dir,
    // moving any corrupt copy aside first.
    if assessment.core_is_broken() {
        let install_dir = Path::new(&manifest.install_directory);
        let existed = manifest
            .primary_exe()
            .map(|p| Path::new(p).exists())
            .unwrap_or(false);
        let restored = payload.install_to(install_dir)?;
        let target = restored.to_string_lossy().to_string();
        // Record the restore so a crash mid-repair is visible on next launch.
        journal.record_applied(
            Action::planned(
                0,
                if existed { ActionKind::ReplaceFile } else { ActionKind::CreateFile },
                target,
            ),
            &clock.iso,
        );
        let _ = journal_store::write(maintenance_dir, journal);
        tracing::info!("repair: restored the core application executable");
    }

    // Report any broken non-core file we cannot restore independently from
    // the monolithic payload, so the user isn't told everything is fixed
    // when it may not be.
    for issue in assessment
        .issues
        .iter()
        .filter(|i| i.component != "core" && i.component != provisioning::PROVISIONING_COMPONENT)
    {
        tracing::warn!(
            path = %issue.path,
            component = %issue.component,
            health = ?issue.health,
            "repair: file needs restore but is not independently packaged (restored with core)"
        );
    }

    Ok(())
}

/// Rewrite the application's configuration document when it is missing or
/// no longer matches what the manifest records.
///
/// Best-effort: a repair that cannot write this file has still repaired
/// everything else, and the app's own fallback (a missing document means
/// "nothing was declined") keeps it running. Failing the whole repair over
/// a derived file would be the worse trade.
fn restore_app_configuration(
    manifest: &InstallationManifest,
    journal: &mut OperationJournal,
    maintenance_dir: &Path,
    clock: &clock::Utc,
) {
    let install_dir = Path::new(&manifest.install_directory);
    let expected = AppProvisioning::from_manifest(manifest);
    let current = provisioning_store::read(install_dir).ok().flatten();
    if current.as_ref() == Some(&expected) {
        return;
    }

    let existed = current.is_some();
    match provisioning_store::write(install_dir, &expected) {
        Ok(path) => {
            journal.record_applied(
                Action::planned(
                    0,
                    if existed { ActionKind::ReplaceFile } else { ActionKind::CreateFile },
                    path.to_string_lossy(),
                ),
                &clock.iso,
            );
            let _ = journal_store::write(maintenance_dir, journal);
            tracing::info!("repair: restored the application configuration");
        }
        Err(e) => tracing::warn!(
            error = %e,
            "repair: could not restore the application configuration — Clippity \
             will start with every feature enabled"
        ),
    }
}

/// Re-create missing shortcuts and rewrite the Add/Remove Programs entry if
/// it went missing. Idempotent: present shortcuts and a present registration
/// are left untouched.
fn restore_integrations(
    manifest: &InstallationManifest,
    product: &ProductInfo,
    paths: &InstallerPaths,
    journal: &mut OperationJournal,
    maintenance_dir: &Path,
    clock: &clock::Utc,
) -> InstallerResult<()> {
    // Recorded shortcuts that vanished, re-created at their exact paths.
    for s in &manifest.shortcuts {
        let path = Path::new(&s.path);
        if !path.exists() {
            if let Err(e) = windows_ops::create_shortcut_at(path, &s.target, "Clippity") {
                tracing::warn!(path = %path.display(), error = %e, "repair: could not restore shortcut");
            } else {
                journal.record_applied(
                    Action::planned(0, ActionKind::CreateShortcut, s.path.clone()),
                    &clock.iso,
                );
            }
        }
    }

    // Re-register with Windows if the ARP entry is gone. We restore the
    // *installed* version's facts, not this build's.
    if windows_ops::uninstall_hive_present().is_none() {
        let maintenance_exe = Path::new(&manifest.maintenance_directory).join(MAINTENANCE_EXE);
        let primary_exe = manifest
            .primary_exe()
            .ok_or_else(|| other("cannot repair registration: manifest records no core exe"))?;
        let core_bytes = manifest
            .files
            .iter()
            .find(|f| f.component == "core")
            .map(|f| f.bytes)
            .unwrap_or(0);

        // Preserve the installed version on the restored entry.
        let mut restored_product = product.clone();
        restored_product.version = manifest.version.clone();

        let mut repair_paths = paths.clone();
        repair_paths.install_dir = manifest.install_directory.clone().into();

        let entry = UninstallEntry::build(
            &restored_product,
            &repair_paths,
            manifest.scope,
            &maintenance_exe.to_string_lossy(),
            primary_exe,
            manifest.install_date_yyyymmdd(),
            core_bytes,
        );
        windows_ops::write_uninstall_entry(&entry)?;
        journal.record_applied(
            Action::planned(
                0,
                ActionKind::WriteRegistryKey,
                installer_platform::entry::UNINSTALL_SUBKEY.to_string(),
            ),
            &clock.iso,
        );
        let _ = journal_store::write(maintenance_dir, journal);
        tracing::info!("repair: re-registered Add/Remove Programs entry");
    }

    Ok(())
}

/// Remove the `<exe>.old` backup that `Payload::install_to` leaves when it
/// replaces a corrupt executable during repair. Best-effort: a still-locked
/// backup is harmless (it is not manifest-owned) and is retried on the next
/// repair. Mirrors the install path's own post-commit backup cleanup.
fn clean_repair_backup(manifest: &InstallationManifest) {
    if let Some(exe) = manifest.primary_exe() {
        let backup = format!("{exe}.old");
        let _ = std::fs::remove_file(&backup);
    }
}

/// SHA-256 (lowercase hex) of a file's contents.
fn file_sha256(path: &Path) -> InstallerResult<String> {
    let bytes = std::fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}
