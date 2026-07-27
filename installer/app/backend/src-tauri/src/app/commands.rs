//! Thin Tauri command handlers. Each validates, delegates to a service,
//! and returns a serializable result. Long-running operations return
//! immediately and stream progress over [`super::PROGRESS_EVENT`].

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use installer_domain::install::{
    build_plan, needs_elevation, Component, InstallOptions, InstallPlan,
};
use installer_domain::progress::ProgressKind;
use installer_domain::uninstall::{DataCategory, RemovalSelection, RemovalSummary};
use installer_domain::update::{InstallStatus, ReleaseChannel, UpdateInfo, VersionInfo};
use installer_domain::wizard::{LaunchRoute, ProductInfo};
use installer_infra::error::{InstallerError, InstallerResult};
use installer_domain::repair::RepairAssessment;
use installer_services::payload::Payload;
use installer_services::recovery::RecoveryOutcome;
use installer_services::{
    elevation, install_service, manifest, recovery, repair_service, uninstall_service,
    update_service,
};

use super::state::AppState;
use super::PROGRESS_EVENT;

/// Liveness probe used by the frontend on mount.
#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

/// Product facts for the current build.
#[tauri::command]
pub fn get_product(state: State<'_, AppState>) -> ProductInfo {
    state.product.clone()
}

/// The selectable component catalog (Components / Modify steps).
#[tauri::command]
pub fn get_components() -> Vec<Component> {
    manifest::components()
}

/// The on-disk data categories (Choose-data / Review-removal steps).
#[tauri::command]
pub fn get_data_categories() -> Vec<DataCategory> {
    manifest::data_categories()
}

/// The existing-install snapshot for the maintenance hub. Reads the real
/// installation manifest when one is present, falling back to this build's
/// product facts otherwise.
#[tauri::command]
pub fn get_install_status(state: State<'_, AppState>) -> InstallStatus {
    let paths = state.paths.lock().expect("paths lock").clone();
    if let Some((_, m)) = installer_services::detect::locate_manifest(&paths) {
        return InstallStatus {
            installed: VersionInfo {
                version: m.version.clone(),
                channel: ReleaseChannel::Stable,
            },
            install_dir: m.install_directory.clone(),
            last_updated: m.install_date.clone(),
        };
    }
    InstallStatus {
        installed: VersionInfo {
            version: state.product.version.clone(),
            channel: ReleaseChannel::Stable,
        },
        install_dir: paths.install_dir.display().to_string(),
        last_updated: String::new(),
    }
}

/// Detect whether (and how) Clippity is installed, correlating the on-disk
/// manifest, the Add/Remove Programs entry, and the installed executable.
/// Backs the maintenance hub's status line and the recovery routing.
#[tauri::command]
pub fn detect_installation(state: State<'_, AppState>) -> installer_domain::state::Detection {
    let paths = state.paths.lock().expect("paths lock").clone();
    installer_services::detect::detect(&paths, &state.product.version)
}

/// Resolve an install plan from the chosen options + component selection.
#[tauri::command]
pub fn resolve_plan(options: InstallOptions, selected: Vec<String>) -> InstallPlan {
    build_plan(options, &manifest::components(), &selected)
}

/// The options + components an existing installation was made with, so the
/// Modify step opens on what is actually installed.
///
/// `None` when nothing is installed (or the manifest is unreadable), which
/// leaves the wizard on its own defaults — the right answer for a fresh
/// install, and the only safe one when we cannot read what is there.
#[tauri::command]
pub fn get_installed_configuration(state: State<'_, AppState>) -> Option<InstalledConfiguration> {
    let paths = state.paths.lock().expect("paths lock").clone();
    let (_, m) = installer_services::detect::locate_manifest(&paths)?;
    Some(InstalledConfiguration {
        options: m.installed_options(),
        selected_components: m.installed_components.clone(),
    })
}

/// What an existing installation chose — the Modify step's starting point.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledConfiguration {
    pub options: InstallOptions,
    pub selected_components: Vec<String>,
}

/// Check the given channel for a newer version than `installed`.
#[tauri::command]
pub fn check_updates(installed: String, channel: ReleaseChannel) -> UpdateInfo {
    update_service::check(&installed, channel)
}

/// Removed/kept byte totals for a proposed removal selection.
#[tauri::command]
pub fn removal_summary(selection: RemovalSelection) -> RemovalSummary {
    uninstall_service::summary(&selection)
}

/// Whether this process holds an elevated token (gates the all-users
/// install scope in the Options step).
#[tauri::command]
pub fn is_elevated() -> bool {
    installer_platform::is_elevated()
}

/// Whether this plan can be executed by the current process, or needs a
/// relaunch with administrator rights first.
///
/// The Review step calls this to decide between starting the install
/// directly and going through [`elevate_and_install`]. A destination the
/// user can already write to answers `false`, which is what keeps the
/// common case free of any UAC prompt.
#[tauri::command]
pub fn plan_requires_elevation(plan: InstallPlan) -> bool {
    needs_elevation(&plan.options) && !installer_platform::is_elevated()
}

/// Relaunch the installer elevated and hand it this plan to execute.
///
/// Returns once the elevated copy has started; the frontend then closes
/// this window so the two never run an install at the same time. A
/// declined UAC prompt surfaces as `ElevationRequired`, and the wizard
/// stays on the Review step so the user can pick another destination.
#[tauri::command]
pub fn elevate_and_install(app: AppHandle, plan: InstallPlan) -> InstallerResult<()> {
    // Refuse if an operation is already running here — relaunching mid
    // install would leave two processes writing the same directory.
    {
        let state = app.state::<AppState>();
        let running = state.operation_running.lock().expect("op lock");
        if *running {
            return Err(InstallerError::Invalid(
                "an operation is already running".into(),
            ));
        }
    }
    elevation::relaunch_with(&plan)
}

/// The plan handed over by an unelevated instance, if this process was
/// launched to resume one. Consumed on first read.
///
/// The frontend calls this on mount: `Some` means skip the wizard and go
/// straight to the Installing step, since the user already made every
/// choice before approving the elevation prompt.
#[tauri::command]
pub fn take_pending_plan(state: State<'_, AppState>) -> Option<InstallPlan> {
    state.pending_plan.lock().expect("pending lock").take()
}

/// Where the frontend should start, when this process was launched
/// interactively with a maintenance mode (the Add/Remove Programs
/// `--uninstall` / `--modify` buttons). `None` means the default setup
/// wizard. The frontend calls this on mount to route the window; without it
/// a maintenance launch always fell through to the fresh-install flow.
#[tauri::command]
pub fn get_launch_route(state: State<'_, AppState>) -> Option<LaunchRoute> {
    state.launch_route
}

/// Whether the recorded installation can only be removed with administrator
/// rights (an all-users install, or an install/maintenance directory under
/// a protected root such as `C:\Program Files`) that this process lacks.
///
/// The Review-removal step calls this to decide between removing in place
/// and relaunching elevated via [`elevate_and_uninstall`] — the removal
/// analogue of [`plan_requires_elevation`]. Answers `false` when this
/// process is already elevated, or when there is no manifest to reason
/// about (the best-effort path removes only user-writable locations).
#[tauri::command]
pub fn uninstall_requires_elevation(state: State<'_, AppState>) -> bool {
    if installer_platform::is_elevated() {
        return false;
    }
    let paths = state.paths.lock().expect("paths lock").clone();
    installer_services::detect::locate_manifest(&paths)
        .map(|(_, m)| m.needs_elevation_to_remove())
        .unwrap_or(false)
}

/// Relaunch the installer elevated and hand it this removal selection to
/// execute. Returns once the elevated copy has started; the frontend then
/// closes this window so the two never run a removal at the same time. A
/// declined UAC prompt surfaces as `ElevationRequired`, leaving the wizard
/// on the Review-removal step.
#[tauri::command]
pub fn elevate_and_uninstall(app: AppHandle, selection: RemovalSelection) -> InstallerResult<()> {
    if !selection.acknowledged {
        return Err(InstallerError::Invalid("removal not acknowledged".into()));
    }
    {
        let state = app.state::<AppState>();
        let running = state.operation_running.lock().expect("op lock");
        if *running {
            return Err(InstallerError::Invalid(
                "an operation is already running".into(),
            ));
        }
    }
    elevation::relaunch_uninstall_with(&selection)
}

/// The removal selection this process was launched to resume after
/// elevation, if any. Consumed on first read — the elevated copy skips the
/// removal wizard and goes straight to Uninstalling.
#[tauri::command]
pub fn take_pending_removal(state: State<'_, AppState>) -> Option<RemovalSelection> {
    state.pending_removal.lock().expect("pending lock").take()
}

/// Real filesystem targets the Complete / maintenance screens open. Resolved
/// from the installation manifest when present (so "Open folder" points at
/// the actual install directory, not the wizard's default), falling back to
/// the resolved paths otherwise.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenancePaths {
    /// The install directory (what "Open folder" opens).
    pub app_dir: String,
    /// The retained user-data root, `%APPDATA%\Clippity` (what the
    /// uninstall-complete "Open retained data folder" opens).
    pub data_dir: String,
    /// This run's log file (what "View log" opens).
    pub log_file: String,
}

/// The concrete paths the Complete and maintenance-hub actions open. Backs
/// the buttons that previously called `openPath("")` (a silent no-op).
#[tauri::command]
pub fn maintenance_paths(state: State<'_, AppState>) -> MaintenancePaths {
    let paths = state.paths.lock().expect("paths lock").clone();
    let app_dir = installer_services::detect::locate_manifest(&paths)
        .map(|(_, m)| m.install_directory)
        .unwrap_or_else(|| paths.install_dir.display().to_string());
    MaintenancePaths {
        app_dir,
        data_dir: paths.app_data.display().to_string(),
        log_file: paths.log_file.display().to_string(),
    }
}

/// Launch the installed application (the "Launch Clippity" button). Resolves
/// the primary executable from the manifest and spawns it detached; errors
/// if nothing is installed to launch.
#[tauri::command]
pub fn launch_app(state: State<'_, AppState>) -> InstallerResult<()> {
    let paths = state.paths.lock().expect("paths lock").clone();
    let exe = installer_services::detect::locate_manifest(&paths)
        .and_then(|(_, m)| m.primary_exe().map(str::to_string));
    match exe {
        Some(exe) => {
            tracing::info!(exe = %exe, "launching installed application");
            std::process::Command::new(&exe).spawn()?;
            Ok(())
        }
        None => Err(InstallerError::Invalid(
            "no installed executable to launch".into(),
        )),
    }
}

/// Begin a fresh install. Returns immediately; progress streams over
/// [`PROGRESS_EVENT`] until a `done` snapshot.
#[tauri::command]
pub fn run_install(app: AppHandle, plan: InstallPlan) -> InstallerResult<()> {
    spawn_install(app, ProgressKind::Install, plan)
}

/// Apply a modification to an existing install (same machinery, modify
/// labels).
#[tauri::command]
pub fn run_modify(app: AppHandle, plan: InstallPlan) -> InstallerResult<()> {
    spawn_install(app, ProgressKind::Modify, plan)
}

/// Scan the installed copy and report what a repair would restore, without
/// changing anything. Backs a "Repair recommended" hub badge.
#[tauri::command]
pub fn assess_repair(state: State<'_, AppState>) -> InstallerResult<RepairAssessment> {
    let paths = state.paths.lock().expect("paths lock").clone();
    repair_service::assess(&paths)
}

/// Repair the installed copy: restore missing/corrupt installer-owned files
/// and re-register integrations, preserving user data and the installed
/// version. Progress streams over [`PROGRESS_EVENT`].
#[tauri::command]
pub fn run_repair(app: AppHandle) -> InstallerResult<()> {
    let payload = Payload::load()?;
    begin_operation(&app)?;
    let (product, paths) = {
        let state = app.state::<AppState>();
        let paths = state.paths.lock().expect("paths lock").clone();
        (state.product.clone(), paths)
    };
    std::thread::spawn(move || {
        let emit = progress_emitter(&app);
        if let Err(e) = repair_service::run(&product, &paths, &payload, &emit) {
            tracing::error!(error = %e, "repair failed");
        }
        end_operation(&app);
    });
    Ok(())
}

/// Resolve any operation left unfinished by a crash/power-loss: roll back a
/// partial one or clear a finished one's leftovers, and report what was (or
/// still needs to be) done. Called by the hub on mount.
#[tauri::command]
pub fn check_recovery(state: State<'_, AppState>) -> InstallerResult<RecoveryOutcome> {
    let paths = state.paths.lock().expect("paths lock").clone();
    recovery::resolve_pending(&paths)
}

/// Download and apply the latest update.
#[tauri::command]
pub fn run_update(app: AppHandle) -> InstallerResult<()> {
    begin_operation(&app)?;
    std::thread::spawn(move || {
        let emit = progress_emitter(&app);
        if let Err(e) = update_service::run(&emit) {
            tracing::error!(error = %e, "update failed");
        }
        end_operation(&app);
    });
    Ok(())
}

/// Remove Clippity per the user's data-removal selection.
#[tauri::command]
pub fn run_uninstall(app: AppHandle, selection: RemovalSelection) -> InstallerResult<()> {
    // Validate up front so a bad request fails synchronously.
    if !selection.acknowledged {
        return Err(InstallerError::Invalid("removal not acknowledged".into()));
    }
    begin_operation(&app)?;
    let paths = {
        let state = app.state::<AppState>();
        let paths = state.paths.lock().expect("paths lock").clone();
        paths
    };
    std::thread::spawn(move || {
        let emit = progress_emitter(&app);
        if let Err(e) = uninstall_service::run(&selection, &paths, &emit) {
            tracing::error!(error = %e, "uninstall failed");
        }
        end_operation(&app);
    });
    Ok(())
}

// ---- internals -----------------------------------------------------------

/// Shared install/modify launcher.
fn spawn_install(app: AppHandle, kind: ProgressKind, plan: InstallPlan) -> InstallerResult<()> {
    // Resolve the payload before claiming the operation slot: an
    // installer built without the staging step must fail immediately and
    // synchronously, not halfway through a progress run.
    let payload = Payload::load()?;

    begin_operation(&app)?;
    let (product, paths) = {
        let state = app.state::<AppState>();
        // Remember where this install is going, so a later uninstall or
        // modify in the same session targets the chosen directory rather
        // than the default the wizard opened with.
        let mut paths = state.paths.lock().expect("paths lock");
        paths.install_dir = plan.options.destination.clone().into();
        (state.product.clone(), paths.clone())
    };
    std::thread::spawn(move || {
        let emit = progress_emitter(&app);
        if let Err(e) = install_service::run(kind, &plan, &product, &paths, &payload, &emit) {
            tracing::error!(error = %e, "install failed");
        }
        end_operation(&app);
    });
    Ok(())
}

/// Build a progress sink that forwards each snapshot to the wizard window.
fn progress_emitter(app: &AppHandle) -> impl Fn(installer_domain::progress::ProgressEvent) + '_ {
    move |event| {
        let _ = app.emit(PROGRESS_EVENT, event);
    }
}

/// Claim the single-operation slot, or reject if one is already running.
fn begin_operation(app: &AppHandle) -> InstallerResult<()> {
    let state = app.state::<AppState>();
    let mut running = state.operation_running.lock().expect("op lock");
    if *running {
        return Err(InstallerError::Invalid(
            "another operation is already running".into(),
        ));
    }
    *running = true;
    Ok(())
}

/// Release the single-operation slot.
fn end_operation(app: &AppHandle) {
    let state = app.state::<AppState>();
    *state.operation_running.lock().expect("op lock") = false;
}
