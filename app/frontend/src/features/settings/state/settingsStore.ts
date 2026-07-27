/**
 * Feature-local Zustand store mirroring the backend's persisted
 * settings snapshot. Source of truth is the backend; this store is a
 * cache that the `useSettings` hook hydrates on mount and refreshes on
 * `clippity://settings/changed`.
 *
 * Lives in `features/settings/state/` (not the global `state/`)
 * because:
 *   - it is feature-scoped (only settings UI + `Providers.tsx` read it),
 *   - the global `themeStore` continues to hold the *resolved* theme
 *     (light|dark) used by Tailwind + Mica — `Providers.tsx` is the
 *     bridge that resolves pref → theme.
 */

import { create } from "zustand";

import type { Settings } from "../types";

interface SettingsStoreState {
  /** Null until the first `getSettings()` resolves. */
  settings: Settings | null;
  setSettings(s: Settings): void;
}

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  settings: null,
  setSettings: (settings) => set({ settings }),
}));
