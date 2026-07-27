//! Headless command execution — the process-side of
//! [`installer_domain::cli`].
//!
//! The domain parses a command line into a [`CliCommand`]; this module runs
//! the *silent* ones without any window, driving the same
//! `installer-services` functions the GUI does and translating the result
//! into a stable [`ExitCode`]. Progress is logged rather than shown. A
//! silent operation never prompts: a request that would need interaction
//! (an install that needs elevation this process lacks, an update the
//! wizard cannot yet apply) returns a specific exit code instead of
//! blocking.

use std::sync::atomic::{AtomicBool, Ordering};

use installer_domain::cli::{CliCommand, CliMode, ExitCode};
use installer_domain::install::{build_plan, needs_elevation, InstallOptions, InstallScope};
use installer_domain::progress::{ProgressEvent, ProgressKind};
use installer_domain::state::InstallState;
use installer_domain::uninstall::{default_removal, RemovalSelection};
use installer_domain::update::{is_update_available, ReleaseChannel};
use installer_infra::error::InstallerError;
use installer_infra::paths::InstallerPaths;
use installer_services::payload::Payload;
use installer_services::{
    detect, install_service, manifest, repair_service, uninstall_service, update_service,
};

/// Run a headless command to completion and return its exit code.
///
/// Only silent, mutating modes reach here; the GUI and interactive modes
/// are handled by the Tauri layer. Errors are mapped to the closest stable
/// [`ExitCode`] so unattended deployment can branch on the result.
pub fn execute(cmd: &CliCommand) -> ExitCode {
    let product = manifest::product();
    let install_dir = cmd
        .install_dir
        .clone()
        .unwrap_or_else(|| product.default_install_dir.clone());
    let paths = InstallerPaths::resolve(install_dir);

    tracing::info!(mode = ?cmd.mode, "executing headless command");

    match cmd.mode {
        CliMode::Install | CliMode::Reinstall => run_install(cmd, &paths),
        CliMode::Modify => run_modify(cmd, &paths),
        CliMode::Repair => run_repair(&paths),
        CliMode::Update => run_update(&paths),
        CliMode::Uninstall => run_uninstall(cmd, &paths),
        // The GUI mode never routes here.
        CliMode::Gui => ExitCode::Success,
    }
}

/// A logging progress sink that also records whether the terminal event
/// asked for a reboot.
fn logging_sink(reboot: &AtomicBool) -> impl Fn(ProgressEvent) + '_ {
    move |event: ProgressEvent| {
        tracing::info!(percent = event.percent, done = event.done, "progress");
        if event.done && event.reboot_required {
            reboot.store(true, Ordering::Relaxed);
        }
    }
}

fn run_install(cmd: &CliCommand, paths: &InstallerPaths) -> ExitCode {
    let payload = match Payload::load() {
        Ok(p) => p,
        Err(e) => return map_error(&e),
    };
    let product = manifest::product();

    // Refuse to downgrade or redundantly install over an equal/newer copy
    // unless this is an explicit reinstall.
    let detection = detect::detect(paths, &product.version);
    if cmd.mode == CliMode::Install {
        match detection.state {
            InstallState::SameVersion => return ExitCode::SameVersionInstalled,
            InstallState::NewerVersion => return ExitCode::NewerVersionInstalled,
            InstallState::Healthy | InstallState::OlderVersion => {
                return ExitCode::AlreadyInstalled
            }
            _ => {}
        }
    }

    let scope = cmd.scope.unwrap_or(InstallScope::CurrentUser);
    let options = InstallOptions {
        destination: paths.install_dir.to_string_lossy().to_string(),
        scope,
        ..InstallOptions::default()
    };

    // A silent install that needs elevation this process does not hold
    // cannot proceed (relaunching would show a UAC prompt).
    if needs_elevation(&options) && !installer_platform::is_elevated() {
        tracing::error!("silent install needs elevation — relaunch the installer as administrator");
        return ExitCode::UacCancelled;
    }

    let selected = cmd.components.clone().unwrap_or_default();
    let plan = build_plan(options, &manifest::components(), &selected);

    let reboot = AtomicBool::new(false);
    let sink = logging_sink(&reboot);
    let kind = if cmd.mode == CliMode::Reinstall {
        ProgressKind::Modify
    } else {
        ProgressKind::Install
    };
    match install_service::run(kind, &plan, &product, paths, &payload, &sink) {
        Ok(()) => success_code(reboot.load(Ordering::Relaxed)),
        Err(e) => map_error(&e),
    }
}

fn run_modify(cmd: &CliCommand, paths: &InstallerPaths) -> ExitCode {
    let Some((_, m)) = detect::locate_manifest(paths) else {
        return ExitCode::NotInstalled;
    };
    let payload = match Payload::load() {
        Ok(p) => p,
        Err(e) => return map_error(&e),
    };
    let product = manifest::product();

    let options = InstallOptions {
        destination: m.install_directory.clone(),
        scope: m.scope,
        ..InstallOptions::default()
    };
    // Modify to the requested component set, defaulting to what is installed.
    let selected = cmd
        .components
        .clone()
        .unwrap_or_else(|| m.installed_components.clone());
    let plan = build_plan(options, &manifest::components(), &selected);

    let reboot = AtomicBool::new(false);
    let sink = logging_sink(&reboot);
    match install_service::run(ProgressKind::Modify, &plan, &product, paths, &payload, &sink) {
        Ok(()) => success_code(reboot.load(Ordering::Relaxed)),
        Err(e) => map_error(&e),
    }
}

fn run_repair(paths: &InstallerPaths) -> ExitCode {
    let payload = match Payload::load() {
        Ok(p) => p,
        Err(e) => return map_error(&e),
    };
    let product = manifest::product();
    let reboot = AtomicBool::new(false);
    let sink = logging_sink(&reboot);
    match repair_service::run(&product, paths, &payload, &sink) {
        Ok(()) => success_code(reboot.load(Ordering::Relaxed)),
        Err(e) => map_error(&e),
    }
}

/// Headless update. The wizard does not run a second, divergent auto-update
/// channel (see the ADR): it reports whether the bundled version is newer,
/// but applying an update this way is not yet available, so it returns a
/// clear code rather than faking success.
fn run_update(paths: &InstallerPaths) -> ExitCode {
    let Some((_, m)) = detect::locate_manifest(paths) else {
        return ExitCode::NotInstalled;
    };
    let product = manifest::product();
    if !is_update_available(&m.version, &product.version) {
        tracing::info!(installed = %m.version, bundled = %product.version, "already up to date");
        return ExitCode::Success;
    }
    let _ = update_service::check(&m.version, ReleaseChannel::Stable);
    tracing::warn!(
        "an update is available but the wizard's headless apply is not yet implemented; \
         use the in-app updater (see docs/installer ADR)"
    );
    ExitCode::GeneralFailure
}

fn run_uninstall(cmd: &CliCommand, paths: &InstallerPaths) -> ExitCode {
    if detect::locate_manifest(paths).is_none()
        && installer_platform::windows_ops::uninstall_hive_present().is_none()
    {
        return ExitCode::NotInstalled;
    }

    // Start from the safe default (remove app machinery, keep user content),
    // then apply the command-line data flags. Silent implies consent.
    let mut selection: RemovalSelection = default_removal(&manifest::data_categories());
    selection.acknowledged = true;
    if cmd.remove_settings && !selection.remove_ids.iter().any(|id| id == "settings") {
        selection.remove_ids.push("settings".to_string());
    }
    if cmd.keep_user_data {
        // Keep everything the user owns — restrict removal to non-destructive
        // application machinery only.
        let destructive: Vec<String> = manifest::data_categories()
            .into_iter()
            .filter(|c| c.destructive)
            .map(|c| c.id)
            .collect();
        selection.remove_ids.retain(|id| !destructive.contains(id));
    }

    let reboot = AtomicBool::new(false);
    let sink = logging_sink(&reboot);
    match uninstall_service::run(&selection, paths, &sink) {
        Ok(()) => success_code(reboot.load(Ordering::Relaxed)),
        Err(e) => map_error(&e),
    }
}

/// Success, upgraded to reboot-required when a step deferred a locked file.
fn success_code(reboot_required: bool) -> ExitCode {
    if reboot_required {
        ExitCode::SuccessRebootRequired
    } else {
        ExitCode::Success
    }
}

/// Map a service error to the closest stable exit code.
fn map_error(e: &InstallerError) -> ExitCode {
    tracing::error!(error = %e, "headless operation failed");
    match e {
        InstallerError::SignatureInvalid => ExitCode::SignatureFailure,
        InstallerError::ElevationRequired => ExitCode::UacCancelled,
        InstallerError::Invalid(msg) if msg.contains("nothing is installed") => {
            ExitCode::NotInstalled
        }
        InstallerError::Invalid(_) => ExitCode::InvalidCommandLine,
        InstallerError::Io(_) | InstallerError::Other(_) => ExitCode::GeneralFailure,
    }
}
