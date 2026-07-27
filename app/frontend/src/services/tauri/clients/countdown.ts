/**
 * Countdown IPC client.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so every consumer
 * (features/countdown, future capture-delay wiring) imports from one place.
 * The wire-format types live in `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::countdown::*` + `services::countdown_service::*`.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import type { CountdownRequest, CountdownStartEvent } from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::countdown`) ----------
export type { CountdownRequest, CountdownStartEvent } from "@clippity/shared";

// ---------- IPC wrappers ----------

/**
 * Position the countdown strip on the cursor monitor's work-area
 * bottom edge, show, and emit `clippity://countdown/start` with the
 * starting seconds. Backend validates `seconds in 1..=60`.
 */
export function startCountdown(seconds: number): Promise<void> {
  return invoke<void, { request: CountdownRequest }>("start_countdown", {
    request: { seconds },
  });
}

/**
 * Hide the strip and abort the in-flight tick. Called by the
 * frontend's Esc handler. Idempotent.
 */
export function cancelCountdown(): Promise<void> {
  return invoke<void>("cancel_countdown");
}

/**
 * Hide the strip after a successful tick-to-zero. Same effect on the
 * service as `cancelCountdown`; kept as a distinct command so the
 * caller can express intent ("the timer expired" vs "the user
 * aborted") — used later when capture-delay wiring lands.
 */
export function finishCountdown(): Promise<void> {
  return invoke<void>("finish_countdown");
}

// ---------- Event listeners ----------

/**
 * Subscribe to `clippity://countdown/start`. Backend emits once per
 * `start_countdown` call after the window is positioned + shown.
 * Returns a sync unsubscribe — return it directly from a `useEffect`.
 */
export function onCountdownStart(
  handler: (payload: CountdownStartEvent) => void
): () => void {
  return on<CountdownStartEvent>(EVENT_NAMES.countdownStart, handler);
}

/**
 * Subscribe to `clippity://countdown/finished`. Backend emits when
 * `finish_countdown` is called (the strip's tick reached zero).
 * Payload is empty — listeners take this as the cue to proceed with
 * the deferred capture. Returns a sync unsubscribe.
 */
export function onCountdownFinished(handler: () => void): () => void {
  return on<void>(EVENT_NAMES.countdownFinished, handler);
}

/**
 * Subscribe to `clippity://countdown/cancelled`. Backend emits when
 * `cancel_countdown` is called (the user aborted via Esc). Payload is
 * empty — listeners take this as the cue to bail out of the deferred
 * capture. Returns a sync unsubscribe.
 */
export function onCountdownCancelled(handler: () => void): () => void {
  return on<void>(EVENT_NAMES.countdownCancelled, handler);
}
