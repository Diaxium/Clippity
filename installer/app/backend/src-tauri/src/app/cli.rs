//! Headless command execution — the process-side of
//! [`installer_domain::cli`].
//!
//! The domain parses a command line into a [`CliCommand`]; this module runs
//! the *silent* ones without any window, driving the same
//! `installer-services` functions the GUI does and translating the result
//! into a stable [`ExitCode`]. Progress is logged rather than shown. A
//! silent operation never prompts: a request that would need interaction
//! (an install that needs elevation this process lacks) returns a specific
//! exit code instead of blocking.

use std::sync::atomic::{AtomicBool, Ordering};

use installer_domain::cli::{CliCommand, CliMode, ExitCode};
use installer_domain::install::{build_plan, needs_elevation, InstallOptions, InstallScope};
use installer_domain::progress::{ProgressEvent, ProgressKind};
use installer_domain::state::InstallState;
use installer_domain::uninstall::{default_removal, RemovalSelection};
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
        CliMode::Update => run_update(cmd, &paths),
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

    let mut options = m.installed_options();
    merge_live_app_preferences(&mut options, paths);
    // Modify to the requested component set, defaulting to what is installed.
    let selected = cmd
        .components
        .clone()
        .unwrap_or_else(|| m.installed_components.clone());
    let plan = build_plan(options, &manifest::components(), &selected);

    let reboot = AtomicBool::new(false);
    let sink = logging_sink(&reboot);
    match install_service::run(
        ProgressKind::Modify,
        &plan,
        &product,
        paths,
        &payload,
        &sink,
    ) {
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

/// Headless online check/download or the private verified bundled apply.
fn run_update(cmd: &CliCommand, paths: &InstallerPaths) -> ExitCode {
    if detect::locate_manifest(paths).is_none() {
        return ExitCode::NotInstalled;
    }
    let reboot = AtomicBool::new(false);
    let sink = logging_sink(&reboot);
    let result = if cmd.apply_bundled_update {
        update_service::apply_bundled(paths, cmd.wait_for_app, cmd.no_restart, &sink)
    } else {
        update_service::run_automatic(paths, cmd.wait_for_app, cmd.no_restart, &sink)
    };
    match result {
        Ok(()) => success_code(reboot.load(Ordering::Relaxed)),
        Err(e) => map_error(&e),
    }
}

/// Preferences can be changed from the installed app after Setup writes its
/// manifest. Preserve those live values during unattended Modify just as the
/// interactive Modify wizard does.
fn merge_live_app_preferences(options: &mut InstallOptions, paths: &InstallerPaths) {
    let settings = paths.local_data.join("data").join("settings.json");
    let Ok(bytes) = std::fs::read(settings) else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return;
    };
    let Some(general) = value.get("general") else {
        return;
    };
    if let Some(value) = general.get("startOnStartup").and_then(|v| v.as_bool()) {
        options.start_at_login = value;
    }
    if let Some(value) = general.get("automaticUpdates").and_then(|v| v.as_bool()) {
        options.automatic_updates = value;
    }
    if let Some(value) = general.get("helpImprove").and_then(|v| v.as_bool()) {
        options.help_improve = value;
    }
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
