import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { createLogger } from "@shared/lib/logger";

const log = createLogger("events");

/**
 * Canonical event names — must stay in lock-step with
 * `backend/src/app/events.rs::names`. Centralizing them prevents the
 * "string typo in two places" failure mode.
 */
export const EVENT_NAMES = {
  onboardingComplete: "clippity://onboarding-complete",
  captureFinished: "clippity://capture/finished",
  overlayOpening: "clippity://overlay/opening",
  overlayShown: "clippity://overlay/shown",
  overlaySnapshotReady: "clippity://overlay/snapshot-ready",
  overlayToggles: "clippity://overlay/toggles",
  toastShow: "clippity://toast/show",
  toastHide: "clippity://toast/hide",
  libraryUpdated: "clippity://library/updated",
  collectionsUpdated: "clippity://collections/updated",
  dashboardView: "clippity://dashboard/view",
  settingsChanged: "clippity://settings/changed",
  countdownStart: "clippity://countdown/start",
  countdownFinished: "clippity://countdown/finished",
  countdownCancelled: "clippity://countdown/cancelled",
  trayOpened: "clippity://tray/opened",
  presetsChanged: "clippity://presets/changed",
  recordingTick: "clippity://recording/tick",
  recordingPreview: "clippity://recording/preview",
  recordingAutoStop: "clippity://recording/auto-stop",
  /** Video/GIF recorder (ADR 0031). Note `recorder/`, not `recording/`
   *  — those belong to the scroll stitcher, which produces a still. */
  recorderTick: "clippity://recorder/tick",
  /** Audio peak levels, ~10×/s while a session has audio, for the HUD's
   *  meters. Its own event rather than fields on the tick: a meter needs
   *  an order of magnitude more updates than a clock. */
  recorderLevels: "clippity://recorder/levels",
  recorderFinished: "clippity://recorder/finished",
  /** Studio's trim export. Scoped to the main window by the backend —
   *  many emits over one export, one surface reading them. The *result*
   *  is the command's return value, not an event. */
  mediaTrimProgress: "clippity://media/trim-progress",
  modelsChanged: "clippity://models/changed",
  modelsProgress: "clippity://models/progress",
  /** Capture-window → overlay mirror of the scroll-direction option.
   *  Frontend-to-frontend (no backend emit), like `overlayToggles`. */
  overlayScrollDirection: "clippity://overlay/scroll-direction",
  /** Capture-window → overlay mirror of a recording **preset's** request
   *  (everything but the rectangle), or null for an ordinary session.
   *  Frontend-to-frontend, like the format mirror beside it. Emitted on
   *  every overlay open so a preset's settings can't leak into the next
   *  non-preset recording. */
  overlayRecordPreset: "clippity://overlay/record-preset",
  /** Capture-window → overlay mirror of the chosen recording format, so
   *  a region/window recording started from the overlay encodes to what
   *  the Record screen selected. Frontend-to-frontend, same mechanism as
   *  `overlayScrollDirection`. */
  overlayRecordFormat: "clippity://overlay/record-format",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

/**
 * Thin wrapper around `listen` that hands back a sync unsubscribe.
 * The Tauri API gives us a promise for the unlisten fn; this helper
 * pre-resolves it so `useEffect` cleanup can return it directly.
 */
export function on<TPayload>(
  event: EventName,
  handler: (payload: TPayload) => void
): () => void {
  let unlisten: UnlistenFn | undefined;
  let cancelled = false;

  void listen<TPayload>(event, (e) => handler(e.payload))
    .then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })
    .catch((err) => {
      // A rejected `listen` means this subscription silently never fires
      // — the handler would just appear dead. Surface it.
      log.warn(`failed to subscribe to "${event}"`, err);
    });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}
