import { useEffect, type ReactNode } from "react";

import { PerformanceOverlay, useDeveloperRuntime } from "@features/developer";
import { useSettings } from "@features/settings";
import { ROUTES } from "@config/constants";
import { invoke } from "@services/tauri";
import { applyAppIcon } from "@services/tauri/clients/settings";
import { useWindowActivity } from "@shared/hooks/useWindowActivity";
import { ContextMenuHost, useNativeContextMenu } from "@shared/ui/contextMenu";
import { useThemeStore } from "@state/themeStore";

import { resolveBackdropTuning } from "@features/settings/lib/backdrop";
import { accentInk, resolveTheme } from "@features/settings/lib/theme";

interface ProvidersProps {
  children: ReactNode;
}

type GlassProfile = {
  glass1: number;
  glass2: number;
  glass3: number;
  glass4: number;
  float: number;
};

const DEFAULT_GLASS_PROFILE: GlassProfile = {
  glass1: 0.86,
  glass2: 0.8,
  glass3: 0.62,
  glass4: 0.52,
  float: 0.96,
};

const ACRYLIC_GLASS_PROFILE: GlassProfile = {
  glass1: 0.72,
  glass2: 0.66,
  glass3: 0.52,
  glass4: 0.46,
  float: 0.9,
};

const GLASS_PROFILES: Record<string, GlassProfile> = {
  mica: DEFAULT_GLASS_PROFILE,
  acrylic: ACRYLIC_GLASS_PROFILE,
  blur: { glass1: 0.78, glass2: 0.72, glass3: 0.58, glass4: 0.5, float: 0.92 },
  tabbed: {
    glass1: 0.88,
    glass2: 0.82,
    glass3: 0.66,
    glass4: 0.56,
    float: 0.96,
  },
  // Clear paints no native material, so the app's own panels are the
  // only thing between the user and the desktop — start from the most
  // transparent profile we ship.
  clear: ACRYLIC_GLASS_PROFILE,
};

/**
 * Resolve one stacked-glass layer into a `color-mix` percentage.
 *
 * `ratio` is the material's shipped profile above; `strength` is the
 * user's per-material "Panel fill" knob (100 = the shipped look, 0 =
 * the panels stop painting entirely so the material / desktop shows
 * through unobstructed). The floor is 0 rather than a fixed 10 % —
 * without that, dialling panel fill down bottomed out at a visible
 * haze and the Clear backdrop could never actually be clear.
 */
function opacityPercent(
  opacity: number,
  ratio: number,
  strength: number,
  max = 96
): string {
  const next = Math.round(opacity * ratio * (strength / 100));
  return `${Math.min(max, Math.max(0, next))}%`;
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
 *      resolved theme down to the Rust side so the native backdrop
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

  // Developer preferences that are module registries rather than
  // rendered state: the frontend log level + its mirror into the
  // backend log file, the IPC metrics recorder, and the feature-flag
  // overrides. Deliberately not gated on developer mode — logging is
  // machinery, and a user who never opens that page still benefits from
  // a session being recorded when something goes wrong.
  useDeveloperRuntime(settings?.developer);

  // Track this window's focus/visibility onto `<html data-idle>` so the
  // CSS in theme.css can pause infinite animations while the window is
  // unfocused, minimized, or hidden in the tray (cuts idle GPU/CPU).
  useWindowActivity();

  /** `undefined` until settings hydrate; gates the backdrop push so we
   *  never tell the backend to (re-)enable native effects before we know the
   *  persisted transparency preference. */
  const windowEffects = settings?.performance.windowEffects;
  const windowBackdrop = settings?.appearance.windowBackdrop;
  const backdropTuning = settings?.appearance.backdropTuning;

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
  // family off it). Chrome opacity flows into both the outer shell and
  // the stacked glass tokens; otherwise inner panels can stay opaque
  // enough to make every backdrop except Acrylic look solid.
  //
  // The three CSS-side tuning knobs land here too. They're per material
  // because the materials don't respond alike: Mica and Tabbed are
  // wallpaper-derived, so the only lever that changes how they read is
  // how much the app's own panels get out of the way (panel fill),
  // while Acrylic and Clear genuinely sample what's behind the window.
  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement;
    root.setAttribute("data-radius", settings.appearance.cornerRadius);
    const flat = settings.performance.windowEffects === false;
    const opacity = flat ? 100 : settings.appearance.windowOpacity;
    const backdrop = settings.appearance.windowBackdrop;
    const profile = GLASS_PROFILES[backdrop] ?? DEFAULT_GLASS_PROFILE;
    const tuning = resolveBackdropTuning(
      settings.appearance.backdropTuning,
      backdrop
    );
    // Flat mode is the "no effects at all" contract — honouring the
    // tuning there would reintroduce the transparency the switch exists
    // to remove, so pin the knobs neutral alongside the pinned opacity.
    const glassStrength = flat ? 100 : tuning.glassStrength;
    root.style.setProperty("--window-opacity", String(opacity / 100));
    root.style.setProperty("--window-opacity-pct", `${opacity}%`);
    root.style.setProperty(
      "--window-glass-1-pct",
      opacityPercent(opacity, profile.glass1, glassStrength)
    );
    root.style.setProperty(
      "--window-glass-2-pct",
      opacityPercent(opacity, profile.glass2, glassStrength)
    );
    root.style.setProperty(
      "--window-glass-3-pct",
      opacityPercent(opacity, profile.glass3, glassStrength)
    );
    root.style.setProperty(
      "--window-glass-4-pct",
      opacityPercent(opacity, profile.glass4, glassStrength)
    );
    root.style.setProperty(
      "--window-float-pct",
      opacityPercent(opacity, profile.float, glassStrength)
    );
    // Unitless multipliers consumed by `calc()` in theme.css, so one
    // knob scales every `.glass-*` / `.surface-*` radius at once.
    root.style.setProperty(
      "--backdrop-blur-scale",
      String((flat ? 100 : tuning.blurStrength) / 100)
    );
    root.style.setProperty(
      "--backdrop-saturate",
      String((flat ? 100 : tuning.saturation) / 100)
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
  // backend clearing native effects so the frosted chrome's GPU cost disappears.
  // Defaults to `rich` until settings hydrate.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute(
      "data-effects",
      windowEffects === false ? "flat" : "rich"
    );
    root.setAttribute("data-backdrop", windowBackdrop ?? "mica");
  }, [windowEffects, windowBackdrop]);

  useEffect(() => {
    // Fire-and-forget — `apply_window_theme` is a Win11-only no-op on
    // other targets, and a backdrop re-tint failure isn't a recoverable
    // error for the UI. `effects` carries the persisted transparency
    // preference so the same call clears native effects when they're off; gate on a
    // known value so we never push `effects: true` before settings load.
    if (windowEffects === undefined) return;
    const backdrop = windowBackdrop ?? "mica";
    void invoke("apply_window_theme", {
      theme,
      effects: windowEffects,
      backdrop,
      // Only `tintStrength` is read on the Rust side; the other knobs
      // are CSS-side and already applied above. Sending the whole
      // struct keeps the wire shape one-to-one with `BackdropTuning`.
      tuning: resolveBackdropTuning(backdropTuning, backdrop),
    }).catch(() => {
      /* swallowed — see comment above */
    });
  }, [theme, windowEffects, windowBackdrop, backdropTuning]);

  // The performance overlay rides on the full-window chrome only. The
  // overlay window is coordinate-sensitive and the countdown / toast /
  // tray windows are sized to their content by the backend, so a
  // floating readout in their corner would either be clipped or change
  // what the user is aiming at.
  const showPerfOverlay =
    settings?.developer.enabled === true &&
    settings.developer.performanceOverlay &&
    isChromeWindow();

  return (
    <>
      {children}
      <ContextMenuHost />
      {showPerfOverlay && <PerformanceOverlay />}
    </>
  );
}
