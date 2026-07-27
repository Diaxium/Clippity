/**
 * Wizard-shell wire-format contracts — mirror Rust `installer_domain::wizard`.
 *
 * The wizard runs one of three *flows* depending on whether Clippity is
 * already installed and what the user chose from the maintenance hub.
 * Each flow is an ordered list of steps rendered in the left rail.
 */

/** Which flow the wizard is currently running. */
export type WizardFlow = "setup" | "maintenance" | "uninstall";

/**
 * Every step id across all three flows. A flow references a subset of
 * these in order; the left rail derives its rows from that subset.
 */
export type StepId =
  // Setup flow
  | "welcome"
  | "options"
  | "components"
  | "review"
  | "installing"
  | "complete"
  // Maintenance flow (shares the hub + complete with uninstall)
  | "maintenance"
  | "check-updates"
  | "update-available"
  | "modify"
  | "applying"
  // Uninstall flow
  | "prepare-uninstall"
  | "choose-data"
  | "review-removal"
  | "uninstalling";

/**
 * Where the frontend should start when the wizard is launched interactively
 * with a maintenance mode. Mirrors Rust `installer_domain::wizard::LaunchRoute`.
 *
 * The Add/Remove Programs Uninstall / Modify buttons run
 * `ClippityWizard.exe --uninstall` / `--modify`; the backend maps that mode
 * to the flow + step the window should open on, since a launched process has
 * no URL hash to route from.
 */
export interface LaunchRoute {
  flow: WizardFlow;
  step: StepId;
}

/** A single row in the left step rail. */
export interface StepMeta {
  id: StepId;
  /** Short label shown in the rail (e.g. "Welcome", "Components"). */
  label: string;
}

/** Immutable product facts shown throughout the wizard. */
export interface ProductInfo {
  name: string;
  /** Version being installed / the version already installed. */
  version: string;
  /** "64-bit" / "32-bit". */
  arch: string;
  publisher: string;
  /** Default install destination, e.g. `C:\Program Files\Clippity`. */
  defaultInstallDir: string;
}
