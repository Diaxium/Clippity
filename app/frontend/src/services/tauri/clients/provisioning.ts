/**
 * Installation-profile IPC client.
 *
 * Reports what the installer was told to install, so the UI can hide the
 * features this installation does not include instead of offering controls
 * that are guaranteed to fail. Read once per window on mount — the
 * configuration behind it only changes when the installer's Modify or Repair
 * runs, and both require Clippity to be closed first.
 *
 * Rust side: `domain::provisioning::*` +
 * `services::provisioning_service::ProvisioningService`.
 */

import { invoke } from "@services/tauri";
import type { InstallationProfile } from "@clippity/shared";

export type {
  Capabilities,
  ProvisioningSource,
  InstallationProfile,
} from "@clippity/shared";
export { UNMANAGED_PROFILE } from "@clippity/shared";

/**
 * Fetch the resolved installation profile.
 *
 * Rust route: `app::commands::provisioning_get` →
 * `services::provisioning_service::ProvisioningService::capabilities`.
 */
export function getInstallationProfile(): Promise<InstallationProfile> {
  return invoke<InstallationProfile>("provisioning_get");
}

/**
 * The backend error code returned when a command is refused because the
 * feature was declined at install time (Rust `AppError::NotInstalled`).
 *
 * Distinct from a generic failure: it is fixable by re-running the
 * installer's Modify flow, which is worth saying rather than reporting
 * "couldn't start the capture".
 */
export const NOT_INSTALLED_CODE = "not-installed";
