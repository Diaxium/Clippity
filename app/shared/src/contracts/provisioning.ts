/**
 * Installation-profile contracts — mirror Rust `domain::provisioning`.
 *
 * The Clippity installer lets a user decline components (OCR engine, GIF
 * encoder, capture integration, cloud sync) and clear preferences
 * (automatic updates, usage reporting). It records those answers beside the
 * installed executable; the backend reads them at startup and resolves them
 * into the capability set below.
 *
 * The UI's job with these is **presentation**: hide or explain a feature the
 * installation does not include, so the user never reaches a control that is
 * guaranteed to fail. Enforcement lives in the backend — every gated command
 * refuses on its own and returns the `not-installed` error code — because the
 * overlay, presets, hotkeys, and the tray all reach the same features by
 * different routes.
 */

/** What this installation is allowed to offer. */
export interface Capabilities {
  /** An OS-global capture hotkey may be registered (component `capture`). */
  globalHotkeys: boolean;
  /** Grab Text / OCR may run (component `ocr`). */
  textRecognition: boolean;
  /** Recordings may be encoded as GIF (component `gif`). */
  gifRecording: boolean;
  /** Clippity may register itself to start with Windows (component
   *  `startup`). */
  startAtLogin: boolean;
  /** Clippity is a registered handler for supported file types (component
   *  `assoc` plus the file-associations preference). */
  fileAssociations: boolean;
  /** Cross-device sync (component `cloud`). Nothing consumes this yet. */
  cloudSync: boolean;
  /** The user left automatic updates on. */
  automaticUpdates: boolean;
  /** The user agreed to share anonymous usage data. */
  usageReporting: boolean;
  /**
   * True when no installer answers were found and every flag above is an
   * assumption rather than the user's choice — a portable build, a
   * development run, or an unreadable configuration.
   *
   * Load-bearing for wording: an unmanaged install must not be told "you
   * declined this", because nobody declined anything.
   */
  unmanaged: boolean;
}

/** Where the capability set came from. */
export type ProvisioningSource =
  /** A usable installer configuration was read. */
  | "installer"
  /** Portable build — there was no installer to ask. */
  | "portable"
  /** No configuration beside the executable (e.g. a development run). */
  | "absent"
  /** Present but unreadable, malformed, or from a newer installer. */
  | "unusable";

/** The resolved installation profile, as returned by `provisioning_get`. */
export interface InstallationProfile {
  capabilities: Capabilities;
  source: ProvisioningSource;
}

/**
 * The profile to assume before the backend answers (and in browser preview,
 * where there is no backend at all): everything available, flagged as not
 * coming from an installer.
 *
 * Optimistic on purpose, and the same default the backend falls back to —
 * briefly showing a feature that turns out to be unavailable is a far
 * smaller failure than hiding features the user paid for on every launch
 * while the first IPC call is in flight.
 */
export const UNMANAGED_PROFILE: InstallationProfile = {
  capabilities: {
    globalHotkeys: true,
    textRecognition: true,
    gifRecording: true,
    startAtLogin: true,
    fileAssociations: true,
    cloudSync: true,
    automaticUpdates: true,
    usageReporting: true,
    unmanaged: true,
  },
  source: "absent",
};
