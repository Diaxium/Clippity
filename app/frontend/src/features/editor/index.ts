/**
 * Editor feature — public surface.
 *
 * `EditorLayout` is mounted by the dashboard when its view is "editor".
 * `EditorDocTitle` is rendered in the shared window title bar (composed by the
 * dashboard) so the document name + status sit beside the brand, matching the
 * reference design. IPC wrappers live in `@services/tauri/clients/editor`.
 */

export { EditorLayout } from "./components/EditorLayout";
export { EditorDocTitle } from "./components/EditorDocTitle";
