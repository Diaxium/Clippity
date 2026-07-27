/**
 * Editor IPC client + cross-window open helper.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so cross-feature
 * consumers (the library's "Open in editor" button, future toast "Edit
 * Capture" handoff, drag-onto-capture-window flow) all import from one place.
 * The wire-format types live in `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::editor::*` + `services::editor_service::*`.
 *
 * **MVP scope (Tier 2)**: load a file-backed image into the editor +
 * save a flattened result. Per-annotation types live entirely in
 * `features/editor/` because the backend treats them as opaque
 * pixels baked into the saved PNG.
 */

import { invoke } from "@services/tauri";
import type { EditorImage } from "@clippity/shared";

import { openDashboard } from "./dashboard";

// ---------- Wire-format types (mirror Rust `domain::editor`) ----------
export type { EditorImage } from "@clippity/shared";

// ---------- IPC wrappers ----------

/**
 * Load the file at `id` (file-backed library entry) as a base64 PNG
 * data URI plus the decoded dimensions. Backend rejects paths that
 * escape the captures directory.
 */
export function editorLoad(id: string): Promise<EditorImage> {
  return invoke<EditorImage, { id: string }>("editor_load", { id });
}

/**
 * Persist a flattened PNG data URI (the frontend's Canvas2D
 * `flatten()` has already baked annotations + effects into pixels)
 * as a new capture file in the captures dir. Returns the new
 * absolute path. Backend emits `library/updated` so the library
 * refreshes without polling.
 */
export function editorSave(dataUri: string): Promise<string> {
  return invoke<string, { dataUri: string }>("editor_save", { dataUri });
}

/**
 * Persist the editor's editable scene (a JSON document) as a sidecar beside
 * capture `id`, so it can be re-opened and edited. Non-destructive — the
 * capture file is untouched. Returns the sidecar's absolute path.
 */
export function editorSaveScene(id: string, scene: string): Promise<string> {
  return invoke<string, { id: string; scene: string }>("editor_save_scene", {
    id,
    scene,
  });
}

// ---------- Cross-window helper ----------

/**
 * Bring the dashboard window forward and switch its view to Editor
 * with `id` loaded. Used by the library card's "Open in editor"
 * button. Routes through `openDashboard` so the same race-free
 * stash-first-then-show pattern is shared with the
 * library/settings cross-window jumps from the capture window.
 */
export async function openInEditor(id: string): Promise<void> {
  await openDashboard("editor", id);
}
