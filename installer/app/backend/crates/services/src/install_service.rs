//! Fresh-install and modify orchestration — a real transaction.
//!
//! An install moves through the journal lifecycle
//! (`Validate → Apply → Commit → Cleanup`), recording each mutating action
//! with the inverse that undoes it. If any step fails, the recorded actions
//! are rolled back — the half-written install dir, the maintenance copy, the
//! shortcuts, the registry entries, and the manifest are all reversed — so a
//! failed install leaves the machine as it found it rather than a partial,
//! unusable state. Only after the manifest is committed and verified does
//! the operation report success.

use std::fs;
use std::path::{Path, PathBuf};

use installer_domain::install::{InstallPlan, InstallScope};
use installer_domain::journal::{
    Action, ActionKind, OperationJournal, OperationType, Outcome, Phase,
};
use installer_domain::progress::{self, ProgressKind};
use installer_domain::provisioning;
use installer_domain::state::{
    InstallationManifest, InstalledFile, RegistryHive, RegistryRecord, ShortcutRecord,
    PRODUCT_ID, SCHEMA_VERSION,
};
use installer_domain::wizard::ProductInfo;
use installer_infra::error::{other, InstallerResult};
use installer_infra::paths::InstallerPaths;
use installer_platform::entry::{UninstallEntry, RUN_SUBKEY, RUN_VALUE, UNINSTALL_SUBKEY};
use installer_platform::windows_ops;

use crate::payload::Payload;
use crate::{
    clock, journal_store, pace, provisioning_store, rollback, state_store, ProgressSink,
};

/// The wizard copy placed in the maintenance directory — the binary
/// Windows runs for Uninstall / Modify / Repair. It embeds the payload, so
/// it can also repair or reinstall without the original Setup.exe.
pub const MAINTENANCE_EXE: &str = "clippity-maintenance.exe";

/// Map a progress kind to the journal's operation type.
fn operation_of(kind: ProgressKind) -> OperationType {
    match kind {
        ProgressKind::Modify => OperationType::Modify,
        ProgressKind::Update => OperationType::Update,
        _ => OperationType::Install,
    }
}

/// Execute an install plan as a rollback-protected transaction, emitting a
/// progress snapshot after each step.
///
/// The checklist comes from the domain; the side effects (payload
/// verification, file copy, shortcut + registry registration, manifest
/// write) are delegated to [`Payload`], `installer-platform`, and
/// [`state_store`], and each is recorded in an [`OperationJournal`] so a
/// failure can be reversed. `kind` distinguishes a fresh install from a
/// modify so the UI labels — and the journal — match.
pub fn run(
    kind: ProgressKind,
    plan: &InstallPlan,
    product: &ProductInfo,
    paths: &InstallerPaths,
    payload: &Payload,
    emit: &ProgressSink<'_>,
) -> InstallerResult<()> {
    let clock = clock::now();
    let all_users = matches!(plan.options.scope, InstallScope::AllUsers);
    let destination = PathBuf::from(&plan.options.destination);
    let maintenance_dir = paths.maintenance_dir(all_users);

    // The manifest and Add/Remove Programs entry must record the *actual*
    // destination, which is `plan.options.destination`. For a fresh install
    // that already equals `paths.install_dir`. For a modify/reinstall it does
    // not: those are invoked without `--install-dir` (the ARP "Modify" button
    // runs `clippity-maintenance.exe --modify`), so `paths.install_dir` still
    // carries the *default* (`C:\Program Files\Clippity`) while the real
    // location comes from the existing installation. Recording `paths` verbatim
    // would rewrite the install directory to the default and break a later
    // repair/uninstall of a per-user or custom-path install. Pin it to the
    // true destination so every recorded location stays consistent.
    let mut install_paths = paths.clone();
    install_paths.install_dir = destination.clone();

    tracing::info!(
        ?kind,
        components = plan.selected_components.len(),
        dest = %plan.options.destination,
        version = %payload.version(),
        all_users,
        "starting install"
    );

    // Open the transaction journal in the maintenance directory before any
    // mutation, so an interruption is always recoverable.
    fs::create_dir_all(&maintenance_dir)?;
    let mut journal = OperationJournal::begin(
        format!("{}-{}", journal_tag(kind), clock.compact),
        operation_of(kind),
        PRODUCT_ID,
        clock.iso.clone(),
    );
    journal.to_version = Some(payload.version().to_string());
    journal.advance(Phase::Plan, &clock.iso);
    let _ = journal_store::write(&maintenance_dir, &journal);

    let tasks = progress::checklist_for(kind);
    let total = tasks.len();
    let mut installed_exe: Option<PathBuf> = None;

    emit(progress::snapshot(kind, tasks.clone(), 0));

    // Run the mutating steps inside a closure so a failure at any point can
    // trigger a single rollback + journal-fail path below.
    let outcome = (|journal: &mut OperationJournal| -> InstallerResult<()> {
        for step in 0..total {
            match tasks[step].id.as_str() {
                // The payload ships inside this executable — nothing to
                // fetch. The row stays because the same checklist drives the
                // download-based update flow.
                "download" => pace(),
                "verify" => {
                    journal.advance(Phase::Validate, &clock.iso);
                    payload.verify()?;
                    let _ = journal_store::write(&maintenance_dir, journal);
                }
                "files" => {
                    journal.advance(Phase::Apply, &clock.iso);
                    // A pre-existing exe is moved to `.old` by `install_to`;
                    // record the right inverse (restore-backup vs delete).
                    let target = destination.join(payload.exe_name());
                    let replaced = target.exists();
                    let backup = destination.join(format!("{}.old", payload.exe_name()));

                    // Record the install-dir creation first, so rollback
                    // removes it (only if empty) after the exe is reversed.
                    record_dir(journal, &destination, &maintenance_dir, &clock);

                    let exe = payload.install_to(&destination)?;
                    let mut action = Action::planned(
                        0,
                        if replaced { ActionKind::ReplaceFile } else { ActionKind::CreateFile },
                        exe.to_string_lossy(),
                    );
                    if replaced {
                        action = action.with_backup(backup.to_string_lossy());
                    }
                    journal.record_applied(action, &clock.iso);
                    let _ = journal_store::write(&maintenance_dir, journal);
                    installed_exe = Some(exe);
                }
                "integrations" => {
                    let exe = installed_exe
                        .clone()
                        .ok_or_else(|| other("internal: file step did not record the exe"))?;
                    apply_integrations(
                        plan, product, &install_paths, payload, all_users, &exe, &clock, journal,
                        &maintenance_dir,
                    )?;
                }
                _ => pace(),
            }
            emit(progress::snapshot(kind, tasks.clone(), step + 1));
        }
        Ok(())
    })(&mut journal);

    match outcome {
        Ok(()) => {
            // Committed above (at the manifest write); clean up and drop the
            // now-satisfied journal, plus the stale `.old` backup.
            journal.advance(Phase::Cleanup, &clock.iso);
            journal.finish(Outcome::Committed, &clock.iso);
            let _ = journal_store::write(&maintenance_dir, &journal);
            clean_backup(&destination, payload.exe_name());
            let _ = journal_store::remove(&maintenance_dir);
            tracing::info!("install complete");
            Ok(())
        }
        Err(e) => {
            // Reverse everything applied so a failed install leaves no
            // partial state, then record the failure.
            tracing::error!(error = %e, "install failed — rolling back");
            journal.fail(e.to_string(), &clock.iso);
            let _ = journal_store::write(&maintenance_dir, &journal);
            let _ = rollback::roll_back(&maintenance_dir, &mut journal);
            let _ = journal_store::remove(&maintenance_dir);
            Err(e)
        }
    }
}

/// Journal id prefix per kind.
fn journal_tag(kind: ProgressKind) -> &'static str {
    match kind {
        ProgressKind::Modify => "modify",
        ProgressKind::Update => "update",
        _ => "install",
    }
}

/// Record a directory-creation action if the directory did not already
/// exist (so rollback only removes a directory the install itself made).
fn record_dir(
    journal: &mut OperationJournal,
    dir: &Path,
    maintenance_dir: &Path,
    clock: &clock::Utc,
) {
    // Only record it as ours to remove when we are the ones creating it.
    if !dir.exists() {
        journal.record_applied(
            Action::planned(0, ActionKind::CreateDirectory, dir.to_string_lossy()),
            &clock.iso,
        );
        let _ = journal_store::write(maintenance_dir, journal);
    }
}

/// Apply every Windows integration the plan implies, recording each action
/// in the journal, then commit the installation manifest that records
/// exactly what was done — so a later uninstall reverses these actions and
/// nothing else.
#[allow(clippy::too_many_arguments)]
fn apply_integrations(
    plan: &InstallPlan,
    product: &ProductInfo,
    paths: &InstallerPaths,
    payload: &Payload,
    all_users: bool,
    installed_exe: &Path,
    clock: &clock::Utc,
    journal: &mut OperationJournal,
    maintenance_dir: &Path,
) -> InstallerResult<()> {
    let exe_str = installed_exe.to_string_lossy().to_string();
    let scope = plan.options.scope;
    let hive = RegistryHive::for_scope(scope);

    // 1. Place the self-contained maintenance/uninstaller copy outside the
    //    install dir.
    record_dir(journal, maintenance_dir, maintenance_dir, clock);
    let maintenance_exe = maintenance_dir.join(MAINTENANCE_EXE);
    copy_self_to(&maintenance_exe)?;
    journal.record_applied(
        Action::planned(0, ActionKind::PlaceMaintenanceExe, maintenance_exe.to_string_lossy()),
        &clock.iso,
    );
    let _ = journal_store::write(maintenance_dir, journal);
    let maintenance_exe_str = maintenance_exe.to_string_lossy().to_string();

    // 2. Shortcuts — recorded by exact path for a precise uninstall/rollback.
    let mut shortcuts: Vec<ShortcutRecord> = Vec::new();
    if plan.options.create_desktop_shortcut {
        let path = windows_ops::create_desktop_shortcut(&exe_str, "Clippity", all_users)?;
        journal.record_applied(
            Action::planned(0, ActionKind::CreateShortcut, path.to_string_lossy()),
            &clock.iso,
        );
        shortcuts.push(ShortcutRecord {
            path: path.to_string_lossy().to_string(),
            target: exe_str.clone(),
        });
    } else {
        let _ = windows_ops::remove_desktop_shortcut("Clippity");
    }
    let start_menu = windows_ops::create_start_menu_shortcut(&exe_str, "Clippity", all_users)?;
    journal.record_applied(
        Action::planned(0, ActionKind::CreateShortcut, start_menu.to_string_lossy()),
        &clock.iso,
    );
    shortcuts.push(ShortcutRecord {
        path: start_menu.to_string_lossy().to_string(),
        target: exe_str.clone(),
    });
    let _ = journal_store::write(maintenance_dir, journal);

    // 3. Start-at-login (per-user Run key), honoring the toggle.
    windows_ops::set_start_at_login(&exe_str, plan.options.start_at_login)?;
    if plan.options.start_at_login {
        journal.record_applied(
            Action::planned(
                0,
                ActionKind::WriteRegistryValue,
                format!(r"HKCU\{RUN_SUBKEY}\{RUN_VALUE}"),
            ),
            &clock.iso,
        );
    }

    // 4. Add/Remove Programs entry, pointing Uninstall/Modify at the
    //    maintenance exe and the icon at the installed app.
    let entry = UninstallEntry::build(
        product,
        paths,
        scope,
        &maintenance_exe_str,
        &exe_str,
        clock.yyyymmdd.clone(),
        payload.bytes(),
    );
    windows_ops::write_uninstall_entry(&entry)?;
    journal.record_applied(
        Action::planned(0, ActionKind::WriteRegistryKey, UNINSTALL_SUBKEY.to_string()),
        &clock.iso,
    );
    let _ = journal_store::write(maintenance_dir, journal);

    // 5. The authoritative manifest — writing it is the commit boundary.
    let mut registry_entries = vec![RegistryRecord {
        hive,
        subkey: UNINSTALL_SUBKEY.to_string(),
        value_name: None, // whole subkey is ours to delete
    }];
    if plan.options.start_at_login {
        registry_entries.push(RegistryRecord {
            hive: RegistryHive::CurrentUser,
            subkey: RUN_SUBKEY.to_string(),
            value_name: Some(RUN_VALUE.to_string()),
        });
    }

    let files = vec![InstalledFile {
        path: exe_str.clone(),
        sha256: Some(payload.sha256().to_string()),
        bytes: payload.bytes(),
        component: "core".to_string(),
        mutable: false,
    }];

    let mut manifest = InstallationManifest {
        schema_version: SCHEMA_VERSION,
        product_id: PRODUCT_ID.to_string(),
        installation_id: state_store::new_installation_id(&exe_str, &clock.iso),
        version: payload.version().to_string(),
        architecture: "x64".to_string(),
        scope,
        install_directory: paths.install_dir.to_string_lossy().to_string(),
        maintenance_directory: maintenance_dir.to_string_lossy().to_string(),
        install_date: clock.iso.clone(),
        installed_components: plan.selected_components.clone(),
        files,
        directories: vec![
            paths.install_dir.to_string_lossy().to_string(),
            maintenance_dir.to_string_lossy().to_string(),
        ],
        registry_entries,
        shortcuts,
        start_at_login: plan.options.start_at_login,
        preferences: plan.options.preferences(),
    };

    // 6. The application's copy of these choices, written beside the exe so
    //    the app itself can honor them (see `domain::provisioning`). Written
    //    from the manifest — not from `plan` — so install, modify and repair
    //    all produce the same document, and recorded as an owned file so
    //    rollback and uninstall remove it with everything else.
    //
    //    A failure here is not fatal to the install: the app treats a
    //    missing document as "nothing was declined", which is the same
    //    behavior every build before this file existed had. Failing a
    //    committed install over it would be the worse outcome.
    match provisioning_store::write_from_manifest(&paths.install_dir, &manifest) {
        Ok(config_path) => {
            let path_str = config_path.to_string_lossy().to_string();
            journal.record_applied(
                Action::planned(0, ActionKind::CreateFile, path_str.clone()),
                &clock.iso,
            );
            manifest.files.push(InstalledFile {
                path: path_str,
                // No hash: every install / modify / repair regenerates the
                // document, so repair restores it by rewriting rather than by
                // comparing bytes. Immutable all the same — the *app* never
                // writes it, which is why a repair may.
                sha256: None,
                bytes: 0,
                component: provisioning::PROVISIONING_COMPONENT.to_string(),
                mutable: false,
            });
        }
        Err(e) => tracing::warn!(
            error = %e,
            "could not write the application configuration — Clippity will \
             start with every feature enabled"
        ),
    }

    // Crossing into Commit: the manifest write makes the new state
    // authoritative. Recorded so a rollback removes it too.
    journal.advance(Phase::Commit, &clock.iso);
    state_store::write(maintenance_dir, &manifest)?;
    journal.record_applied(
        Action::planned(
            0,
            ActionKind::WriteManifest,
            state_store::manifest_path(maintenance_dir).to_string_lossy(),
        ),
        &clock.iso,
    );
    let _ = journal_store::write(maintenance_dir, journal);

    Ok(())
}

/// Remove the stale `Clippity.exe.old` backup after a committed install.
fn clean_backup(destination: &Path, exe_name: &str) {
    let backup = destination.join(format!("{exe_name}.old"));
    if backup.exists() {
        if let Err(e) = fs::remove_file(&backup) {
            tracing::warn!(path = %backup.display(), error = %e, "could not remove stale backup");
        }
    }
}

/// Copy the running installer to `dest` (the maintenance/uninstaller
/// location). A no-op when we are already running from `dest` — which is
/// the case when the maintenance exe itself drives a repair/modify.
fn copy_self_to(dest: &Path) -> InstallerResult<()> {
    let current = std::env::current_exe()?;
    if current == dest {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    // Replace a stale maintenance exe if present (best-effort rename-away).
    if dest.exists() {
        let backup = dest.with_extension("old");
        let _ = fs::remove_file(&backup);
        let _ = fs::rename(dest, &backup);
    }
    fs::copy(&current, dest)?;
    tracing::info!(dest = %dest.display(), "placed maintenance executable");
    Ok(())
}
