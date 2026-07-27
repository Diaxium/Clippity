/**
 * Read this installation's capabilities, hydrating them on first mount.
 *
 * The one entry point components should use: it both triggers the fetch (a
 * no-op after the first caller in this window) and subscribes to the result,
 * so a panel can gate a control without knowing anything about how the
 * profile is loaded.
 */

import { useEffect } from "react";

import { hydrateCapabilities, useCapabilitiesStore } from "./capabilitiesStore";
import type { Capabilities } from "@services/tauri/clients/provisioning";

export function useCapabilities(): Capabilities {
  const capabilities = useCapabilitiesStore((s) => s.capabilities);

  useEffect(() => {
    void hydrateCapabilities();
  }, []);

  return capabilities;
}
