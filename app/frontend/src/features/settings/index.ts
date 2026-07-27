/**
 * Settings feature — public surface.
 *
 * Only `SettingsLayout` is exported. The dashboard window mounts it
 * via `DashboardLayout`'s `view === "settings"` branch. Anything that
 * wants to *read* persisted settings (e.g. `Providers.tsx`) imports
 * from `@services/tauri/clients/settings` instead.
 */

export { SettingsLayout } from "./components/SettingsLayout";
export { useSettings } from "./hooks/useSettings";
export { useSettingsPatch } from "./hooks/useSettingsPatch";
export { useSettingsStore } from "./state/settingsStore";
