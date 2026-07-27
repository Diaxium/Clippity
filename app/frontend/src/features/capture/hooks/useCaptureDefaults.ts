/**
 * Seed the capture window's per-session option state from the persisted
 * `settings.capture` defaults.
 *
 * The capture store ships hardcoded fallbacks (`DEFAULT_TOGGLES`) so the
 * window renders instantly before settings hydrate; this hook then
 * overwrites them once with the user's saved defaults the moment the
 * settings snapshot arrives. `hydrateDefaults` self-guards on
 * `defaultsHydrated`, so:
 *   - it seeds exactly once per window realm (≈ once per app run — the
 *     capture window is created hidden at startup and only shown/hidden,
 *     never torn down), and
 *   - a later Settings → Capture edit that broadcasts `settings/changed`
 *     never yanks the user's in-session toggle tweaks out from under
 *     them. Changing a *default* seeds the *next* fresh run, matching how
 *     "defaults" read everywhere else in the app.
 *
 * Settings are read from the feature-local settings store (hydrated for
 * every window by `Providers.tsx`), so no extra IPC is issued here.
 */

import { useEffect } from "react";

import { useSettingsStore } from "@features/settings";

import { useCaptureStore } from "../state/captureStore";

export function useCaptureDefaults(): void {
  const capture = useSettingsStore((s) => s.settings?.capture ?? null);
  const hydrateDefaults = useCaptureStore((s) => s.hydrateDefaults);

  useEffect(() => {
    if (capture) hydrateDefaults(capture);
  }, [capture, hydrateDefaults]);
}
