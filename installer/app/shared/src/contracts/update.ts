/**
 * Update / maintenance contracts — mirror Rust `installer_domain::update`.
 *
 * Backs the "Check for updates" and "Update available" steps and the
 * maintenance-hub summary.
 */

/** Release channel the user tracks. */
export type ReleaseChannel = "stable" | "beta" | "nightly";

/** A resolved version + its channel. */
export interface VersionInfo {
  version: string;
  channel: ReleaseChannel;
}

/** Signature-verification state of a downloaded update package. */
export type SignatureState = "unverified" | "verified" | "invalid";

/**
 * The result of an online update check. `available` is false when the
 * installed version already matches the latest on the chosen channel.
 */
export interface UpdateInfo {
  installed: VersionInfo;
  latest: VersionInfo;
  available: boolean;
  /** Download size of the update package, in bytes. */
  downloadBytes: number;
  signature: SignatureState;
  /** Human-readable "what's new" bullets for the latest release. */
  releaseNotes: string[];
}

/** Snapshot shown on the maintenance hub for an existing install. */
export interface InstallStatus {
  installed: VersionInfo;
  installDir: string;
  /** ISO 8601 timestamp of the last install/update. */
  lastUpdated: string;
}
