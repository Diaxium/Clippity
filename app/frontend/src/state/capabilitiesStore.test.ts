import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ProvisioningClient from "@services/tauri/clients/provisioning";

const getInstallationProfile = vi.fn();

// Only the IPC call is stubbed — `UNMANAGED_PROFILE` has to stay real, since
// it is the optimistic default the store starts from and the assertions below
// compare against it.
vi.mock("@services/tauri/clients/provisioning", async () => {
  const actual = await vi.importActual<typeof ProvisioningClient>(
    "@services/tauri/clients/provisioning"
  );
  return { ...actual, getInstallationProfile };
});

const {
  hydrateCapabilities,
  resetCapabilitiesHydration,
  useCapabilitiesStore,
} = await import("./capabilitiesStore");
const { UNMANAGED_PROFILE } = await import(
  "@services/tauri/clients/provisioning"
);

/** A managed install with OCR and the GIF encoder declined. */
const DECLINED = {
  capabilities: {
    ...UNMANAGED_PROFILE.capabilities,
    textRecognition: false,
    gifRecording: false,
    unmanaged: false,
  },
  source: "installer" as const,
};

beforeEach(() => {
  getInstallationProfile.mockReset();
  resetCapabilitiesHydration();
  useCapabilitiesStore.setState({
    capabilities: UNMANAGED_PROFILE.capabilities,
    source: UNMANAGED_PROFILE.source,
    hydrated: false,
  });
});

describe("capabilitiesStore", () => {
  it("starts optimistic so nothing is hidden before the backend answers", () => {
    // A feature that flickers in is a far smaller failure than every feature
    // being hidden for a frame on every launch.
    const s = useCapabilitiesStore.getState();
    expect(s.capabilities.textRecognition).toBe(true);
    expect(s.capabilities.gifRecording).toBe(true);
    expect(s.hydrated).toBe(false);
  });

  it("applies the backend profile", async () => {
    getInstallationProfile.mockResolvedValue(DECLINED);
    await hydrateCapabilities();
    const s = useCapabilitiesStore.getState();
    expect(s.capabilities.textRecognition).toBe(false);
    expect(s.capabilities.gifRecording).toBe(false);
    expect(s.source).toBe("installer");
    expect(s.hydrated).toBe(true);
  });

  it("fetches once however many components ask", async () => {
    // Several gated components mount in the same tick, all before the first
    // call resolves — the `hydrated` flag alone wouldn't stop them, so this
    // guards the shared in-flight promise.
    getInstallationProfile.mockResolvedValue(DECLINED);
    await Promise.all([
      hydrateCapabilities(),
      hydrateCapabilities(),
      hydrateCapabilities(),
    ]);
    await hydrateCapabilities();
    expect(getInstallationProfile).toHaveBeenCalledTimes(1);
    // …and the one result still landed.
    expect(useCapabilitiesStore.getState().capabilities.gifRecording).toBe(false);
  });

  it("keeps everything available when the backend call fails", async () => {
    // The backend refuses declined features on its own, so guessing
    // optimistically here costs a control that reports "not installed" when
    // pressed — never a broken app.
    getInstallationProfile.mockRejectedValue(new Error("no backend"));
    await hydrateCapabilities();
    const s = useCapabilitiesStore.getState();
    expect(s.capabilities).toEqual(UNMANAGED_PROFILE.capabilities);
    expect(s.hydrated).toBe(true);
  });

  it("does not retry after a failure", async () => {
    getInstallationProfile.mockRejectedValue(new Error("no backend"));
    await hydrateCapabilities();
    await hydrateCapabilities();
    expect(getInstallationProfile).toHaveBeenCalledTimes(1);
  });
});
