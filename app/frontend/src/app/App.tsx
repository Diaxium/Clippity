import { lazy, Suspense, useEffect, useState } from "react";
import { MotionConfig } from "motion/react";

import { Providers } from "@app/Providers";
import { resolveWindow } from "@app/windowRoutes";
import { ROUTES } from "@config/constants";
import { useSettingsStore } from "@features/settings";
import { ErrorBoundary } from "@shared/ui";
import { useThemeStore } from "@state/themeStore";

// Split into its own chunk — only the capture/main windows ever mount
// the wizard, so the transient utility windows shouldn't ship it.
const OnboardingLayout = lazy(() =>
  import("@features/onboarding").then((m) => ({ default: m.OnboardingLayout }))
);

/** Reads the current hash route (e.g. `#/main` → `/main`). */
function currentRoute(): string {
  return window.location.hash.replace(/^#/, "") || "/";
}

/**
 * Routes that bypass the onboarding gate. Overlay / countdown / toast /
 * tray are transient utility windows triggered by the user (or a global
 * hotkey) AFTER the wizard has run — letting the wizard hijack them
 * would mean a captured region opens the wizard, which is nonsense.
 */
function isSystemRoute(route: string): boolean {
  return (
    route.startsWith(ROUTES.overlay) ||
    route.startsWith(ROUTES.countdown) ||
    route.startsWith(ROUTES.toast) ||
    route.startsWith(ROUTES.tray) ||
    route.startsWith(ROUTES.recorderFrame)
  );
}

/**
 * Root component. Composition order:
 *   1. Providers (theme, store hydration)
 *   2. MotionConfig for the reduced-motion preference
 *   3. The window-specific component matched by the URL hash —
 *      optionally swapped for the OnboardingLayout when the user
 *      hasn't completed first-launch setup yet.
 *
 * Each Tauri window loads the same bundle and selects its component
 * via the hash route — that's how five OS windows share one frontend
 * build without per-window bundles.
 */
export function App() {
  return (
    <ErrorBoundary scope="app">
      <Providers>
        <AppShell />
      </Providers>
    </ErrorBoundary>
  );
}

function AppShell() {
  const [route, setRoute] = useState<string>(currentRoute);
  const reduceMotion = useThemeStore((s) => s.reduceMotion);
  const settings = useSettingsStore((s) => s.settings);

  useEffect(() => {
    const onHash = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const WindowComponent = resolveWindow(route);
  // System routes always render normally; user-facing routes (capture
  // / main) render the wizard until `settings.general.onboarded`
  // flips true. `Providers` triggers a `settings_get` on mount, so
  // `settings === null` while that first fetch is in flight — render
  // the normal window during that gap rather than blanking the UI
  // (matches the legacy app's behaviour: getSettings returns null in
  // browser-only previews and the wizard skips).
  const showOnboarding =
    !isSystemRoute(route) && settings !== null && !settings.general.onboarded;

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      {/* Windows and the wizard are lazy chunks; Suspense covers the
          brief load while the matched chunk resolves. */}
      <Suspense fallback={null}>
        {showOnboarding && settings ? (
          <OnboardingLayout
            settings={settings}
            // Persistence flips `onboarded` via the wizard's complete()
            // handler — once the settings/changed event lands, this
            // selector re-runs and `showOnboarding` becomes false.
            // `onDone` exists as a belt-and-suspenders dismiss path in
            // case the patch propagation lags the user's click; the
            // visual handoff to the normal window is still settings-
            // driven so a stale local state can't get stuck.
            onDone={() => {
              /* no-op — gate flips via settings selector */
            }}
          />
        ) : (
          <WindowComponent />
        )}
      </Suspense>
    </MotionConfig>
  );
}
