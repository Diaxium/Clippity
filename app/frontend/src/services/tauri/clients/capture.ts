/**
 * Capture IPC client.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so cross-feature
 * consumers can import them without reaching into another feature folder.
 * The wire-format types now live in `@clippity/shared` and are re-exported
 * here so existing call sites keep importing them from this module.
 *
 * Rust side: `domain::capture::*` + `services::capture_service::*`.
 */

import { invoke, on, EVENT_NAMES } from "@services/tauri";
import type {
  CaptureRequest,
  CaptureResult,
  ClipboardIngest,
} from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::capture`) ----------
// Definitions live in `@clippity/shared`; re-exported for backwards compat.
export type {
  CaptureType,
  CustomMode,
  CaptureToggles,
  CaptureDelay,
  CaptureRequest,
  CaptureResult,
  ClipboardIngest,
} from "@clippity/shared";

// ---------- IPC wrappers ----------

/**
 * Snap the primary monitor with the supplied request shape.
 *
 * Rust route: `app::commands::capture_fullscreen` →
 * `services::capture_service::CaptureService::execute_fullscreen`.
 */
export function captureFullscreen(
  request: CaptureRequest
): Promise<CaptureResult> {
  return invoke<CaptureResult, { request: CaptureRequest }>(
    "capture_fullscreen",
    { request }
  );
}

/**
 * Clipboard custom mode — ingest whatever the system clipboard holds.
 * Opens no overlay (the data already exists). `preview` rides through to
 * the saved capture's "Preview in Editor" flag for the image branch.
 *
 * Rust route: `app::commands::ingest_clipboard`.
 */
export function ingestClipboard(preview: boolean): Promise<ClipboardIngest> {
  return invoke<ClipboardIngest, { preview: boolean }>("ingest_clipboard", {
    preview,
  });
}

/**
 * Subscribe to capture completion events from any window. Backend
 * emits `clippity://capture/finished` after every successful capture
 * (fullscreen OR region — both go through the same event channel).
 *
 * Returns a sync unsubscribe — return it directly from a `useEffect`.
 */
export function onCaptureFinished(
  handler: (result: CaptureResult) => void
): () => void {
  return on<CaptureResult>(EVENT_NAMES.captureFinished, handler);
}
