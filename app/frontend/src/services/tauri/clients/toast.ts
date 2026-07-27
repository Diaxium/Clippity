/**
 * Toast IPC client.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so every feature
 * that wants to emit a toast (capture / overlay / library / editor / future
 * custom modes) imports from one place — never from `features/toast/`. The
 * wire-format types live in `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::toast::*` + `services::toast_service::*`.
 *
 * **MVP scope**: only the `error` variant is reachable. The reserved
 * variants exist for wire-shape stability. The backend rejects non-`error`
 * variants with `AppError::Unsupported`.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import type { ToastPayload, ToastShowEvent } from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::toast`) ----------
export type {
  PickedColor,
  PaletteSwatch,
  RecorderToastFormat,
  RecordingMode,
  ToastPayload,
  ToastKind,
  ToastDurations,
  ToastCorner,
  ToastShowEvent,
} from "@clippity/shared";

// ---------- IPC wrappers ----------

/**
 * Show a toast with `payload`. Backend repositions the toast against
 * the cursor's monitor's work area before revealing, then emits
 * `clippity://toast/show` with the payload + per-kind durationMs.
 *
 * **MVP**: only `{ kind: "error", message }` is accepted by the
 * backend. Other variants reject with `AppError::Unsupported`.
 *
 * Rust route: `app::commands::show_toast` →
 * `services::toast_service::ToastService::show`.
 */
export function showToast(payload: ToastPayload): Promise<void> {
  return invoke<void, { payload: ToastPayload }>("show_toast", { payload });
}

/**
 * Sugar for the common case — build a `kind: "error"` payload from
 * a message and show it. Use this wherever a `console.warn` would
 * have surfaced an error in the legacy.
 */
export function emitErrorToast(message: string): Promise<void> {
  return showToast({ kind: "error", message });
}

/**
 * Hide the toast window. `ToastLayout` calls this after its 220 ms
 * exit animation completes; backend also emits `clippity://toast/hide`
 * so any passive listeners can sync state.
 */
export function hideToast(): Promise<void> {
  return invoke<void>("hide_toast");
}

/**
 * Resize the toast to fit measured content (logical pixels). Backend
 * clamps + re-anchors. The frontend should only call this when the
 * measured height actually changed (idempotent skip in
 * `useToastResize`).
 */
export function resizeToast(width: number, height: number): Promise<void> {
  return invoke<void, { width: number; height: number }>("resize_toast", {
    width,
    height,
  });
}

/**
 * Bring the capture window forward — used by the toast's Focus
 * button. Available from any window; thin wrapper around the
 * backend's `restore_window("capture")` primitive.
 */
export function showCaptureWindow(): Promise<void> {
  return invoke<void>("show_capture_window");
}

// ---------- Event listeners ----------

/**
 * Subscribe to `clippity://toast/show`. Backend emits this every
 * time a toast is revealed, carrying the payload + per-kind
 * `durationMs` (0 = sticky).
 *
 * Returns a sync unsubscribe — return it directly from a `useEffect`.
 */
export function onToastShow(
  handler: (event: ToastShowEvent) => void
): () => void {
  return on<ToastShowEvent>(EVENT_NAMES.toastShow, handler);
}

/**
 * Subscribe to `clippity://toast/hide`. Backend emits this when it
 * hides the toast (the common path is the frontend's own post-
 * animation hideToast call — so the listener mostly sees its own
 * emit, idempotently).
 */
export function onToastHide(handler: () => void): () => void {
  return on<unknown>(EVENT_NAMES.toastHide, () => handler());
}
