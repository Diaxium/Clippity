/**
 * AI-model manager IPC client.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so cross-feature
 * consumers (the Models settings page, the capture window's Object-mode
 * trigger) import from one place. The wire-format types live in
 * `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::models::*` + `services::model_service::*`.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import type {
  ModelInfo,
  ReleaseCheck,
  ModelProgress,
  ObjectModelReadiness,
} from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::models`) ----------
export type {
  ModelTask,
  ModelPhase,
  ModelInfo,
  ReleaseCheck,
  ModelProgress,
  ObjectModelReadiness,
} from "@clippity/shared";

// ---------- IPC wrappers ----------

/** Snapshot every registry model with its live status. The Models
 *  settings page fetches this on mount; transitions then arrive via
 *  `onModelsChanged`. */
export function modelsList(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("models_list");
}

/** Start downloading `id` (no-op when installed or already in flight).
 *  Resolves as soon as the worker is spawned — progress streams via
 *  `onModelsProgress`, the final status via `onModelsChanged`. */
export function modelsDownload(id: string): Promise<void> {
  return invoke<void, { id: string }>("models_download", { id });
}

/** Flag an in-flight download for cancellation. No-op otherwise. */
export function modelsCancelDownload(id: string): Promise<void> {
  return invoke<void, { id: string }>("models_cancel_download", { id });
}

/** Best-effort live check of every GitHub-hosted model against its latest
 *  published release. The Models page fires this on open alongside
 *  {@link modelsList}; reachable models come back as `ReleaseCheck`s,
 *  unreachable ones are simply absent. Cached briefly server-side. */
export function modelsCheckUpdates(): Promise<ReleaseCheck[]> {
  return invoke<ReleaseCheck[]>("models_check_updates");
}

/** Self-update `id` to the latest published GitHub release, fetching that
 *  release's live assets. Like {@link modelsDownload}, resolves once the
 *  worker spawns — progress streams via `onModelsProgress`, final status
 *  via `onModelsChanged`. */
export function modelsUpdate(id: string): Promise<void> {
  return invoke<void, { id: string }>("models_update", { id });
}

/** Delete an installed model from disk (cancels any in-flight download
 *  first) and drop its cached inference session. */
export function modelsRemove(id: string): Promise<void> {
  return invoke<void, { id: string }>("models_remove", { id });
}

/** Readiness check + auto-download policy for the Object capture
 *  mode's configured detector. `ready` → open the overlay;
 *  `downloading` → a fetch is in flight (possibly just started by this
 *  call); `missing` → not installed and auto-download is off. */
export function ensureObjectModel(): Promise<ObjectModelReadiness> {
  return invoke<ObjectModelReadiness>("ensure_object_model");
}

// ---------- Event wrappers ----------

/** Subscribe to `clippity://models/changed` — the full model list after
 *  any status transition (download start/done/error/cancel, removal). */
export function onModelsChanged(
  handler: (models: ModelInfo[]) => void
): () => void {
  return on<ModelInfo[]>(EVENT_NAMES.modelsChanged, handler);
}

/** Subscribe to `clippity://models/progress` — throttled byte ticks
 *  from an active download. */
export function onModelsProgress(
  handler: (progress: ModelProgress) => void
): () => void {
  return on<ModelProgress>(EVENT_NAMES.modelsProgress, handler);
}
