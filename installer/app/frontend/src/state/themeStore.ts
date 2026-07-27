import { create } from "zustand";

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
  setTheme: (theme: Theme) => void;
  setReduceMotion: (value: boolean) => void;
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
  setTheme: (theme) => set({ theme }),
  setReduceMotion: (reduceMotion) => set({ reduceMotion }),
  toggleTheme: () =>
    set((s) => ({ theme: s.theme === "light" ? "dark" : "light" })),
}));
