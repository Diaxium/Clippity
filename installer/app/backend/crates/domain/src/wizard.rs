//! Wizard flows and the step rows each one renders.

use serde::{Deserialize, Serialize};

use crate::cli::CliMode;

/// Which flow the wizard is currently running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WizardFlow {
    Setup,
    Maintenance,
    Uninstall,
}

/// Every step id across all three flows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StepId {
    Welcome,
    Options,
    Components,
    Review,
    Installing,
    Complete,
    Maintenance,
    CheckUpdates,
    UpdateAvailable,
    Modify,
    Applying,
    PrepareUninstall,
    ChooseData,
    ReviewRemoval,
    Uninstalling,
}

impl StepId {
    /// Short rail label.
    pub fn label(self) -> &'static str {
        match self {
            StepId::Welcome => "Welcome",
            StepId::Options => "Options",
            StepId::Components => "Components",
            StepId::Review => "Review",
            StepId::Installing => "Installing",
            StepId::Complete => "Complete",
            StepId::Maintenance => "Maintenance",
            StepId::CheckUpdates => "Check for updates",
            StepId::UpdateAvailable => "Update available",
            StepId::Modify => "Modify installation",
            StepId::Applying => "Applying changes",
            StepId::PrepareUninstall => "Prepare uninstall",
            StepId::ChooseData => "Choose data",
            StepId::ReviewRemoval => "Review removal",
            StepId::Uninstalling => "Uninstalling",
        }
    }
}

/// Immutable product facts shown throughout the wizard.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductInfo {
    pub name: String,
    pub version: String,
    pub arch: String,
    pub publisher: String,
    pub default_install_dir: String,
}

/// Where an interactive launch should drop the user, given the mode the
/// process was started with. Backs the fix for the Add/Remove Programs
/// buttons: `ClippityWizard.exe --uninstall` (and `--modify`) open the
/// GUI, and without this the shell had no way to tell the frontend which
/// flow to enter — so it always fell back to the fresh-install wizard.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRoute {
    pub flow: WizardFlow,
    /// The step to jump straight to within `flow`.
    pub step: StepId,
}

/// Resolve the launch route for a maintenance mode, or `None` for a mode
/// that opens the default setup wizard (a fresh or explicit install).
///
/// `Uninstall` enters the removal flow at its first real step (skipping the
/// shared hub); `Modify`, `Repair`, and `Update` enter the maintenance flow
/// at the matching action. `Install` / `Reinstall` / `Gui` return `None`.
pub fn launch_route_for(mode: CliMode) -> Option<LaunchRoute> {
    let (flow, step) = match mode {
        CliMode::Uninstall => (WizardFlow::Uninstall, StepId::PrepareUninstall),
        CliMode::Modify => (WizardFlow::Maintenance, StepId::Modify),
        CliMode::Repair => (WizardFlow::Maintenance, StepId::Maintenance),
        CliMode::Update => (WizardFlow::Maintenance, StepId::CheckUpdates),
        CliMode::Install | CliMode::Reinstall | CliMode::Gui => return None,
    };
    Some(LaunchRoute { flow, step })
}

/// The ordered step rail for a flow.
pub fn steps_for(flow: WizardFlow) -> Vec<StepId> {
    match flow {
        WizardFlow::Setup => vec![
            StepId::Welcome,
            StepId::Options,
            StepId::Components,
            StepId::Review,
            StepId::Installing,
            StepId::Complete,
        ],
        WizardFlow::Maintenance => vec![
            StepId::Maintenance,
            StepId::CheckUpdates,
            StepId::UpdateAvailable,
            StepId::Modify,
            StepId::Applying,
            StepId::Complete,
        ],
        WizardFlow::Uninstall => vec![
            StepId::Maintenance,
            StepId::PrepareUninstall,
            StepId::ChooseData,
            StepId::ReviewRemoval,
            StepId::Uninstalling,
            StepId::Complete,
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_flow_ends_on_complete() {
        for flow in [
            WizardFlow::Setup,
            WizardFlow::Maintenance,
            WizardFlow::Uninstall,
        ] {
            assert_eq!(steps_for(flow).last(), Some(&StepId::Complete));
        }
    }

    #[test]
    fn maintenance_and_uninstall_share_the_hub() {
        assert_eq!(steps_for(WizardFlow::Maintenance)[0], StepId::Maintenance);
        assert_eq!(steps_for(WizardFlow::Uninstall)[0], StepId::Maintenance);
    }

    #[test]
    fn flow_serializes_kebab() {
        let json = serde_json::to_string(&WizardFlow::Uninstall).unwrap();
        assert_eq!(json, "\"uninstall\"");
    }

    #[test]
    fn uninstall_launch_skips_the_hub() {
        // The Add/Remove Programs Uninstall button must land on the first
        // removal step, not the shared maintenance hub.
        let route = launch_route_for(CliMode::Uninstall).unwrap();
        assert_eq!(route.flow, WizardFlow::Uninstall);
        assert_eq!(route.step, StepId::PrepareUninstall);
    }

    #[test]
    fn modify_launch_enters_maintenance_modify() {
        let route = launch_route_for(CliMode::Modify).unwrap();
        assert_eq!(route.flow, WizardFlow::Maintenance);
        assert_eq!(route.step, StepId::Modify);
    }

    #[test]
    fn install_modes_have_no_special_route() {
        assert!(launch_route_for(CliMode::Install).is_none());
        assert!(launch_route_for(CliMode::Reinstall).is_none());
        assert!(launch_route_for(CliMode::Gui).is_none());
    }

    #[test]
    fn launch_route_serializes_kebab_fields() {
        let route = launch_route_for(CliMode::Uninstall).unwrap();
        let json = serde_json::to_string(&route).unwrap();
        assert_eq!(json, r#"{"flow":"uninstall","step":"prepare-uninstall"}"#);
    }
}
