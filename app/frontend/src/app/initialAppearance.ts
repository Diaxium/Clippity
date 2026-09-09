import type { Settings } from "@clippity/shared";

import { accentInk, resolveTheme } from "@features/settings/lib/theme";
import { useThemeStore } from "@state/themeStore";

type InitialAppearance = Pick<Settings, "appearance" | "performance">;

/**
 * Apply color-sensitive settings before React renders its first frame.
 *
 * The regular Providers bridge keeps these values live after mount. Startup is
 * deliberately separate: effects in a newly-created or boot-hidden WebView can
 * run after the window is first painted, which used to leave the static light
 * theme in place until the window received user input.
 */
export function applyInitialAppearance(settings?: InitialAppearance): void {
  const store = useThemeStore.getState();
  const osPrefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = settings
    ? resolveTheme(settings.appearance.theme, osPrefersDark)
    : store.theme;
  const reduceMotion = settings
    ? settings.performance.reducedAnimations
    : store.reduceMotion;

  if (settings) {
    store.setTheme(theme);
    store.setReduceMotion(reduceMotion);
    store.setAppIcon(settings.appearance.appIcon);

    const style = document.documentElement.style;
    style.setProperty("--color-accent", settings.appearance.accent);
    style.setProperty(
      "--color-accent-ink",
      accentInk(settings.appearance.accent)
    );
  }

  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute(
    "data-motion",
    reduceMotion ? "reduced" : "normal"
  );
}
