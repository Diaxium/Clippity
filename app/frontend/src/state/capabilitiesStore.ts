import { create } from "zustand";

import {
  getInstallationProfile,
  UNMANAGED_PROFILE,
} from "@services/tauri/clients/provisioning";
import type {
  Capabilities,
  InstallationProfile,
  ProvisioningSource,
} from "@services/tauri/clients/provisioning";

/**
 * What this installation may offer, as reported by the backend from the
 * installer's recorded choices.
 *
 * App-wide rather than feature-local — the Home launcher, the capture-mode
 * panel, and three Settings panels all read it — so it lives beside
 * `themeStore` instead of under `features/`.
 *
 * Not a `useSettings`-style live subscription: the installer's configuration
 * only changes when its Modify or Repair flow runs, and both require closing
 * Clippity first. One fetch per window is the whole lifecycle, and
 * [`hydrateCapabilities`] is idempotent so the six windows racing to call it
 * cost one IPC round-trip each and nothing more.
 *
 * The pre-fetch value is deliberately optimistic (everything available): a
 * feature that flickers in and then disappears is a smaller failure than
 * every feature being hidden for a frame on every launch.
 */
interface CapabilitiesState {
  capabilities: Capabilities;
  source: ProvisioningSource;
  /** False until the backend has answered — the optimistic default is in
   *  place. UI that would rather wait than flicker can check this. */
  hydrated: boolean;
  setProfile: (profile: InstallationProfile) => void;
}

export const useCapabilitiesStore = create<CapabilitiesState>((set) => ({
  capabilities: UNMANAGED_PROFILE.capabilities,
  source: UNMANAGED_PROFILE.source,
  hydrated: false,
  setProfile: (profile) =>
    set({
      capabilities: profile.capabilities,
      source: profile.source,
      hydrated: true,
    }),
}));

/**
 * The single in-flight fetch, so concurrent callers share it.
 *
 * The `hydrated` flag alone is not enough: it only flips once the call has
 * resolved, so every gated component mounting in the same tick would pass
 * that check and fire its own IPC call. Held at module scope (not in the
 * store) because it is machinery, not state anything renders from.
 */
let inFlight: Promise<void> | null = null;

/**
 * Fetch the installation profile into the store, once per window.
 *
 * A failure leaves the optimistic default in place and marks the store
 * hydrated anyway: the backend refuses declined features on its own, so the
 * cost of guessing wrong here is a control that reports "not installed" when
 * pressed — not a broken app. Retrying (or blocking the UI) would trade that
 * for something worse.
 */
export function hydrateCapabilities(): Promise<void> {
  if (useCapabilitiesStore.getState().hydrated) return Promise.resolve();
  inFlight ??= getInstallationProfile()
    .then((profile) => useCapabilitiesStore.getState().setProfile(profile))
    .catch(() => useCapabilitiesStore.setState({ hydrated: true }));
  return inFlight;
}

/** Reset the fetch guard. Test-only — production windows hydrate once and
 *  live with the result for the process's lifetime. */
export function resetCapabilitiesHydration(): void {
  inFlight = null;
}
