/**
 * Install-configuration contracts — mirror Rust `installer_domain::install`.
 *
 * Covers the Options and Components steps of the setup flow (and the
 * Modify step of maintenance, which reuses the same shapes).
 */

/** Who the install targets. `all-users` requires elevation. */
export type InstallScope = "current-user" | "all-users";

/** Toggleable install-time behaviors (the Options step switches). */
export interface InstallOptions {
  destination: string;
  createDesktopShortcut: boolean;
  startAtLogin: boolean;
  automaticUpdates: boolean;
  /** Anonymous usage + diagnostics sharing. */
  helpImprove: boolean;
  scope: InstallScope;
  /** File-association registration (images / videos / GIFs). */
  fileAssociations: boolean;
}

/**
 * A selectable feature in the Components step. `required` components are
 * always installed (checkbox disabled + checked); the rest are opt-in.
 */
export interface Component {
  id: string;
  name: string;
  description: string;
  /** Installed on-disk footprint, in bytes. */
  sizeBytes: number;
  required: boolean;
  /** Recommended defaults are pre-checked; optional extras are not. */
  recommendedDefault: boolean;
}

/**
 * What an existing installation was made with — the Modify step's starting
 * point, reconstructed from the on-disk installation manifest.
 *
 * Modify has to open on these rather than on the wizard's defaults: it
 * rewrites the manifest and the application's configuration from whatever
 * the store holds, so defaults would quietly undo the user's original
 * choices the moment they pressed "Apply changes".
 */
export interface InstalledConfiguration {
  options: InstallOptions;
  selectedComponents: string[];
}

/**
 * A fully-resolved plan the backend can execute — the Review step renders
 * this and `installer_services::install` consumes it.
 */
export interface InstallPlan {
  options: InstallOptions;
  /** Component ids the user selected. */
  selectedComponents: string[];
  /** Sum of selected component footprints, in bytes. */
  componentBytes: number;
  /** Estimated total disk space including scratch/overhead, in bytes. */
  estimatedDiskBytes: number;
}
