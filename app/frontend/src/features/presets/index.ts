/**
 * Presets feature — public surface. The capture window and dashboard mount
 * `PresetsLayout` as their Presets view. Listing / running presets elsewhere
 * (the tray) goes through `@services/tauri/clients/presets` +
 * `@shared/hooks/usePresets`.
 */

export { PresetsLayout } from "./components/PresetsLayout";
