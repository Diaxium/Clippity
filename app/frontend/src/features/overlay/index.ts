/**
 * Overlay feature — Region-mode selection overlay.
 *
 * Public surface is just the root layout. Tests + sub-components live
 * inside the feature; nothing else needs to reach in. Cross-feature
 * triggers (capture window opening the overlay) go through
 * `@services/tauri/clients/overlay` per ADR 0001.
 */

export { OverlayLayout } from "./components/OverlayLayout";
