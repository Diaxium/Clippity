/**
 * Apply the persisted developer preferences to the running window.
 *
 * Mounted once per window from `Providers`, next to the theme and
 * keybind bridges, because these are the same shape of thing: module
 * registries that have to follow a settings change without every reader
 * subscribing to the store.
 *
 * Three bindings, all idempotent:
 *   1. the frontend logger's severity floor, and whether records are
 *      mirrored into the backend log file,
 *   2. the IPC metrics recorder (armed only by `commandTiming`),
 *   3. the feature-flag override registry.
 *
 * Deliberately *not* gated on developer mode as a whole. Logging is
 * machinery: a user who never opens this page still has a log file, and
 * a bug report is worth far more with the session that produced it
 * attached.
 */

import { useEffect } from "react";

import {
  installLogForwarding,
  uninstallLogForwarding,
} from "@services/tauri/clients/developer";
import { isTauriContext } from "@services/tauri";
import { setFeatureFlagOverrides } from "@shared/lib/featureFlags";
import { configureIpcMetrics } from "@shared/lib/ipcMetrics";
import { setLogLevel } from "@shared/lib/logger";
import type { DeveloperSettings } from "@features/settings/types";

export function useDeveloperRuntime(developer: DeveloperSettings | undefined) {
  const level = developer?.frontendLog;
  const commandTiming = developer?.commandTiming;
  const slowCommandMs = developer?.slowCommandMs;
  const flags = developer?.featureFlags;

  useEffect(() => {
    // `undefined` while settings hydrate — leave the build's own floor
    // in force rather than briefly silencing the boot sequence.
    if (level === undefined) return;
    setLogLevel(level);
  }, [level]);

  useEffect(() => {
    // Only inside Tauri: in the browser preview and under vitest there
    // is no backend to forward to, and every attempt would fail.
    if (!isTauriContext()) return;
    installLogForwarding();
    return () => uninstallLogForwarding();
  }, []);

  useEffect(() => {
    configureIpcMetrics({
      enabled: commandTiming === true,
      slowMs: slowCommandMs,
    });
  }, [commandTiming, slowCommandMs]);

  useEffect(() => {
    setFeatureFlagOverrides(flags);
  }, [flags]);
}
