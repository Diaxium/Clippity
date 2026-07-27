/**
 * Installation-model + detection contracts — mirror Rust
 * `installer_domain::state`.
 *
 * Backs the maintenance hub's real status line and the recovery routing.
 * The full `InstallationManifest` lives on disk and is not normally sent to
 * the frontend; the wizard consumes the resolved [`Detection`] instead.
 */

import type { InstallScope } from "./install";

/**
 * The health of an install as resolved by the backend's detection. Sources
 * that disagree resolve to a recovery-oriented state, never a guess.
 */
export type InstallState =
  | "not-installed"
  | "healthy"
  | "damaged"
  | "partial"
  | "older-version"
  | "same-version"
  | "newer-version"
  | "legacy-unmanaged";

/** The resolved detection result shown on the maintenance hub. */
export interface Detection {
  state: InstallState;
  installedVersion: string | null;
  installDirectory: string | null;
  scope: InstallScope | null;
  installationId: string | null;
}
