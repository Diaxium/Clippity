//! Application-wide state held by Tauri (`app.manage`).

use std::sync::Mutex;

use installer_domain::cli::{self, ParsedCli};
use installer_domain::install::InstallPlan;
use installer_domain::uninstall::RemovalSelection;
use installer_domain::wizard::{launch_route_for, LaunchRoute, ProductInfo};
use installer_infra::paths::InstallerPaths;
use installer_services::{elevation, manifest};

/// Installer-wide state. The wizard is single-window and mostly
/// stateless — the frontend holds the user's in-progress selections —
/// so this carries just the resolved paths, product facts, and a guard
/// against launching two long-running operations at once.
pub struct AppState {
    pub product: ProductInfo,
    pub paths: Mutex<InstallerPaths>,
    /// True while an install / update / uninstall is running, so a second
    /// trigger is rejected rather than racing the first.
    pub operation_running: Mutex<bool>,
    /// A plan handed over by an unelevated instance via `--resume`. Set
    /// only when this process was started to finish someone else's
    /// install; taken once by the frontend on mount.
    pub pending_plan: Mutex<Option<InstallPlan>>,
    /// A removal selection handed over via `--resume-uninstall`. Set only
    /// when this process was launched elevated to finish an uninstall the
    /// unelevated instance could not; taken once by the frontend on mount.
    pub pending_removal: Mutex<Option<RemovalSelection>>,
    /// Where the frontend should start when launched interactively with a
    /// maintenance mode (`--uninstall` / `--modify` from the Add/Remove
    /// Programs buttons). `None` for a plain setup launch or a resume.
    pub launch_route: Option<LaunchRoute>,
}

impl AppState {
    pub fn new() -> Self {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let pending_plan = resume_plan_from_args(&args);
        let pending_removal = resume_removal_from_args(&args);
        // A resume takes over the whole window, so it wins over any launch
        // route; the interactive `--uninstall` / `--modify` route only
        // applies to a non-resume launch.
        let launch_route = if pending_plan.is_some() || pending_removal.is_some() {
            None
        } else {
            launch_route_from_args(&args)
        };

        // A resumed install already knows its destination; adopt it now so
        // every path-dependent command agrees before the wizard resumes.
        let install_dir = pending_plan
            .as_ref()
            .map(|p| p.options.destination.clone())
            .unwrap_or_else(|| installer_infra::paths::DEFAULT_INSTALL_DIR.to_string());

        Self {
            product: manifest::product(),
            paths: Mutex::new(InstallerPaths::resolve(install_dir)),
            operation_running: Mutex::new(false),
            pending_plan: Mutex::new(pending_plan),
            pending_removal: Mutex::new(pending_removal),
            launch_route,
        }
    }
}

/// Load the handoff plan this process was launched with, if any.
///
/// A malformed or missing handoff file is logged and ignored rather than
/// aborting startup: the wizard simply opens at Welcome, which is a
/// recoverable outcome for the user.
fn resume_plan_from_args(args: &[String]) -> Option<InstallPlan> {
    let path = elevation::resume_path_from_args(args)?;
    match elevation::read_handoff(&path) {
        Ok(plan) => Some(plan),
        Err(e) => {
            tracing::error!(error = %e, path = %path.display(), "ignoring unreadable handoff");
            None
        }
    }
}

/// Load the removal selection this process was launched to resume, if any.
/// Like the install handoff, an unreadable file is ignored rather than
/// aborting startup — the wizard falls back to the maintenance hub.
fn resume_removal_from_args(args: &[String]) -> Option<RemovalSelection> {
    let path = elevation::resume_uninstall_path_from_args(args)?;
    match elevation::read_uninstall_handoff(&path) {
        Ok(selection) => Some(selection),
        Err(e) => {
            tracing::error!(error = %e, path = %path.display(), "ignoring unreadable uninstall handoff");
            None
        }
    }
}

/// Derive the interactive launch route from the command line. A parse error
/// (or a mode with no special route) simply opens the default setup wizard.
fn launch_route_from_args(args: &[String]) -> Option<LaunchRoute> {
    match cli::parse(args) {
        ParsedCli::Run(cmd) => launch_route_for(cmd.mode),
        _ => None,
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
