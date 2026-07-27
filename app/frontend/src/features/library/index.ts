/**
 * Library feature — public surface.
 *
 * `LibraryLayout` (the list page) and `PaletteView` (the large
 * single-palette view, mounted by the dashboard's `palette` view) are
 * exported. The capture window mounts `LibraryLayout` via
 * `CaptureLayout`'s `nav === "history"` dispatch. Anything that wants to
 * *read* library data imports from `@services/tauri/clients/library`.
 */

export { LibraryLayout } from "./components/LibraryLayout";
export { PaletteView } from "./components/PaletteView";
