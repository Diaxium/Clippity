/**
 * Presets feature — public surface. The dashboard mounts `PresetsLayout`
 * as its Presets view. Listing / running presets elsewhere (the tray)
 * goes through `@services/tauri/clients/presets` + `@shared/hooks/usePresets`.
 */

export { PresetsLayout } from "./components/PresetsLayout";
