/**
 * Uninstall contracts — mirror Rust `installer_domain::uninstall`.
 *
 * Backs the "Choose data to remove" and "Review removal" steps. Data is
 * split into what is removed by default (application files) and what is
 * *kept* unless the user opts in (captures, projects, credentials) — the
 * design's core promise that user content survives an uninstall.
 */

/** A category of on-disk data the uninstaller can remove or keep. */
export interface DataCategory {
  id: string;
  name: string;
  /** On-disk footprint, in bytes. */
  sizeBytes: number;
  /**
   * When true this category is destructive user content (captures,
   * projects, credentials) — removal is opt-in and disabled by default.
   * When false it is application machinery removed by default.
   */
  destructive: boolean;
}

/**
 * The user's removal choices: the set of category ids selected for
 * deletion. Everything not in the set is retained on the device.
 */
export interface RemovalSelection {
  removeIds: string[];
  /** Export settings to a file before removing anything. */
  exportSettings: boolean;
  /** Confirmation toggle on the Review step — required to proceed. */
  acknowledged: boolean;
}

/** Computed totals shown on the Review-removal step. */
export interface RemovalSummary {
  removedBytes: number;
  keptBytes: number;
}
