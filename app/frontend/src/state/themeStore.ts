import { create } from "zustand";

import type { AppIconStyle } from "@clippity/shared";

/**
 * Theme + motion preferences.
 *
 * Persistence happens through the backend settings service (single
 * source of truth across windows). This store only mirrors the
 * resolved values for the current window so React reads stay sync.
 *
 * On first run we honor the OS preference; once the backend has
 * loaded user settings, `hydrate()` overwrites with the saved values.
 */

export type Theme = "light" | "dark";

interface ThemeState {
  theme: Theme;
  reduceMotion: boolean;
  /** Mirror of `appearance.appIcon` for the current window. Lets the
   *  shared `Brand` mark follow the user's icon-style choice without the
   *  caller threading it (parallels how `theme` is mirrored here). */
  appIcon: AppIconStyle;
  setTheme: (theme: Theme) => void;
  setReduceMotion: (value: boolean) => void;
  setAppIcon: (value: AppIconStyle) => void;
  toggleTheme: () => void;
}

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function initialReduceMotion(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme(),
  reduceMotion: initialReduceMotion(),
  // Colour is the shipped default; Providers overwrites once the backend
  // settings hydrate (matching theme / reduceMotion).
  appIcon: "color",
  setTheme: (theme) => set({ theme }),
  setReduceMotion: (reduceMotion) => set({ reduceMotion }),
  setAppIcon: (appIcon) => set({ appIcon }),
  toggleTheme: () =>
    set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
}));
