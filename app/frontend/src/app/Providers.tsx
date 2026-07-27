import { useEffect, type ReactNode } from "react";

import { useSettings } from "@features/settings";
import { ROUTES } from "@config/constants";
import { invoke } from "@services/tauri";
import { applyAppIcon } from "@services/tauri/clients/settings";
import { useWindowActivity } from "@shared/hooks/useWindowActivity";
import { ContextMenuHost, useNativeContextMenu } from "@shared/ui/contextMenu";
import { useThemeStore } from "@state/themeStore";

import { accentInk, resolveTheme } from "@features/settings/lib/theme";

interface ProvidersProps {
  children: ReactNode;
}

/**
 * Full-window "chrome" (the dashboard / capture-home windows) vs the
 * transient utility windows. The density + UI-scale appearance knobs
 * apply only to chrome windows: the overlay is coordinate-sensitive
 * (crosshair geometry) and the countdown / toast / tray are sized
 * precisely by the backend, so re-spacing or zooming them would break
 * their layouts. Resolved once from the window's hash route — each Tauri
 * window's route is fixed for its lifetime.
 */
function isChromeWindow(): boolean {
  if (typeof window === "undefined") return true;
  const route = window.location.hash.replace(/^#/, "");
  return !(
    route.startsWith(ROUTES.overlay) ||
    route.startsWith(ROUTES.countdown) ||
    route.startsWith(ROUTES.toast) ||
    route.startsWith(ROUTES.tray)
  );
}

/**
 * Top-level providers + side-effect bindings.
 *
 * Responsibilities:
 *   1. Hydrate the persisted settings on mount and stash them in the
 *      feature-local store so panels + theme bridge read live values.
 *   2. Bridge `settings.appearance.theme` (pref: light/dark/system)
 *      into `themeStore.theme` (resolved: light/dark). Watch the OS
 *      `(prefers-color-scheme)` query when pref is "system" so the
 *      window flips when the OS does.
 *   3. Mirror the active accent into `--color-accent` (the derived
 *      shades — `--color-accent-soft` etc. — follow via `color-mix` in
 *      `theme.css`) and its contrast-aware foreground into
 *      `--color-accent-ink` so text/icons on a solid accent fill stay
 *      readable when the user picks a light accent.
 *   4. Mirror the resolved motion preference (Performance → "Reduced
 *      animations") into `themeStore` so the `data-motion` attribute
 *      stays correct (Tailwind + CSS read it).
 *   5. Keep the `<html data-theme>` attribute synced and push the
 *      resolved theme down to the Rust side so the Win11 Mica backdrop
 *      tints follow the in-app palette.
 *   6. Own the right-click contract for the window: suppress the
 *      WebView2 menu everywhere and mount the shared menu host. This
 *      lives here rather than in each window because all six Tauri
 *      windows boot the same bundle through `App` — one mount point
 *      means no window can ship without it.
 */
export function Providers({ children }: ProvidersProps) {
  const settings = useSettings();

  useNativeContextMenu();

  // Track this window's focus/visibility onto `<html data-idle>` so the
  // CSS in theme.css can pause infinite animations while the window is
  // unfocused, minimized, or hidden in the tray (cuts idle GPU/CPU).
  useWindowActivity();

  /** `undefined` until settings hydrate; gates the backdrop push so we
   *  never tell the backend to (re-)enable Mica before we know the
   *  persisted transparency preference. */
  const windowEffects = settings?.performance.windowEffects;

  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setReduceMotion = useThemeStore((s) => s.setReduceMotion);
  const setAppIcon = useThemeStore((s) => s.setAppIcon);
  const motion = useThemeStore((s) => (s.reduceMotion ? "reduced" : "normal"));

  // Resolve settings.appearance.theme → themeStore.theme.
  useEffect(() => {
    if (!settings) return;
    const osPrefersDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    setTheme(resolveTheme(settings.appearance.theme, osPrefersDark));
    // Performance → "Reduced animations" is the single in-app motion
    // master; the OS `prefers-reduced-motion` is honored independently by
    // the media query in theme.css.
    setReduceMotion(settings.performance.reducedAnimations);
  }, [settings, setTheme, setReduceMotion]);

  // Follow OS prefs while the pref is "system".
  useEffect(() => {
    if (!settings || settings.appearance.theme !== "system") return;
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [settings, setTheme]);

  // Push the active accent into the root CSS var. `theme.css` derives
  // the soft / hover shades via `color-mix(in srgb, var(--color-accent) …)`
  // so they follow automatically. `--color-accent-ink` is the
  // luminance-aware foreground for solid accent fills — computed here
  // because CSS can't branch on a custom property's lightness.
  useEffect(() => {
    if (!settings) return;
    const accent = settings.appearance.accent;
    const root = document.documentElement.style;
    root.setProperty("--color-accent", accent);
    root.setProperty("--color-accent-ink", accentInk(accent));
  }, [settings]);

  // Corner roundness → `data-radius` (theme.css scales the `--radius-*`
  // family off it) and chrome opacity → the inline `--window-opacity`
  // var (0.6–1.0; the shell utilities color-mix the canvas against it).
  // Both are purely visual, so they apply on every window.
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    root.setAttribute("data-radius", settings.appearance.cornerRadius);
    root.style.setProperty(
      "--window-opacity",
      String(settings.appearance.windowOpacity / 100)
    );
  }, [settings]);

  // Density (`data-density` → Tailwind's `--spacing` base) and UI scale
  // (a CSS `zoom` on the root) reflow / magnify the whole layout, so they
  // apply to the full-window chrome only — never the overlay or the
  // backend-sized utility windows (see `isChromeWindow`).
  useEffect(() => {
    if (!settings || !isChromeWindow()) return;
    const root = document.documentElement;
    root.setAttribute("data-density", settings.appearance.density);
    root.style.setProperty("zoom", String(settings.appearance.uiScale / 100));
  }, [settings]);

  // App icon — mirror the style into the theme store (every window, so
  // the in-app `Brand` mark follows it) and push it down to the OS tray +
  // taskbar icons. The IPC push fires only from a chrome window so the
  // transient utility windows don't re-race the swap on every open; it's
  // fire-and-forget (the Rust side swallows decode/set failures), like
  // the `apply_window_theme` push.
  useEffect(() => {
    if (!settings) return;
    setAppIcon(settings.appearance.appIcon);
    if (isChromeWindow()) void applyAppIcon(settings.appearance.appIcon);
  }, [settings, setAppIcon]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-motion", motion);
  }, [motion]);

  // Drive the CSS transparency mode. `flat` drops `backdrop-filter` blur
  // and forces opaque glass tokens (see `theme.css`), pairing with the
  // backend clearing Mica so the frosted chrome's GPU cost disappears.
  // Defaults to `rich` until settings hydrate.
  useEffect(() => {
    document.documentElement.setAttribute(
      "data-effects",
      windowEffects === false ? "flat" : "rich"
    );
  }, [windowEffects]);

  useEffect(() => {
    // Fire-and-forget — `apply_window_theme` is a Win11-only no-op on
    // other targets, and a Mica re-tint failure isn't a recoverable
    // error for the UI. `effects` carries the persisted transparency
    // preference so the same call clears Mica when it's off; gate on a
    // known value so we never push `effects: true` before settings load.
    if (windowEffects === undefined) return;
    void invoke("apply_window_theme", { theme, effects: windowEffects }).catch(
      () => {
        /* swallowed — see comment above */
      }
    );
  }, [theme, windowEffects]);

  return (
    <>
      {children}
      <ContextMenuHost />
    </>
  );
}
