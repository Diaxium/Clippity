import { useCallback } from "react";

import { TauriCommandError } from "@services/tauri";
import {
  captureFullscreen,
  ingestClipboard,
} from "@services/tauri/clients/capture";
import {
  onCountdownCancelled,
  onCountdownFinished,
  startCountdown,
} from "@services/tauri/clients/countdown";
import { ensureObjectModel } from "@services/tauri/clients/models";
import {
  beginRegionCapture,
  emitOverlayToggles,
} from "@services/tauri/clients/overlay";
import { emitOverlayScrollDirection } from "@services/tauri/clients/scroll";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { buildRequest, useCaptureStore } from "../state/captureStore";
import { CUSTOM_MODE_TO_OVERLAY } from "../modes";
import type { CaptureResult } from "../types";

interface UseCaptureWorkflow {
  /** Dispatches the right backend call based on the current
   *  `captureType`. Fullscreen → `capture_fullscreen` (returns the
   *  `CaptureResult`). Region + Window → `begin_region_capture` (opens
   *  the overlay in that mode; the result arrives later via
   *  `capture/finished`). Custom is deferred to a follow-up port — its
   *  disabled tile prevents reaching that branch in the UI. */
  trigger: () => Promise<CaptureResult | null>;
}

/**
 * Capture-window workflow dispatch. Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * the switch lives here (in the source feature's workflow hook), not
 * in `windows/CaptureWindow.tsx`. Cross-feature IPC wrappers are
 * pulled from `@services/tauri/clients/` so no cross-feature import
 * is needed.
 *
 * Toggles are always mirrored to the overlay window before the
 * dispatch fires so the overlay's bottom bar reflects the user's
 * pre-set choices.
 *
 * The "Preview in Editor" toggle is not wired here. Its value rides the
 * capture request (fullscreen) / mirrored overlay toggles
 * (region/window/custom) to the backend, which stamps it onto the
 * `capture/finished` payload; the main window's persistent listener
 * ({@link useOpenEditorOnPreview}) opens the editor when it's set. One
 * decision point, sourced from the toggle the capture actually used —
 * so preview works across every mode + entry point (tech-debt row 639).
 *
 * Errors surface as `emitErrorToast` calls — the legacy `setLastError`
 * inline-text path was deleted when toast feature #3 landed (the
 * captureStore no longer carries a `lastError` field).
 *
 * Returns `null` (not throws) on failure so callers don't need a
 * try/catch; the user sees an error toast instead.
 */
export function useCaptureWorkflow(): UseCaptureWorkflow {
  const trigger = useCallback(async () => {
    const state = useCaptureStore.getState();

    try {
      // Clipboard mode is instant and overlay-less — read the system
      // clipboard directly. No toggle-mirror, no delay, no overlay; an
      // empty clipboard surfaces a friendly toast, not an error.
      if (
        state.captureType === "custom" &&
        state.customMode === "clipboard"
      ) {
        const ingest = await ingestClipboard(state.preview);
        if (ingest.kind === "empty") {
          void emitErrorToast("Clipboard is empty — copy something first.");
        }
        return null;
      }

      // Mirror toggles → overlay before any dispatch so the overlay's
      // bottom bar starts from the user's pre-set choices (including
      // "Preview in Editor"). The overlay sends the freshest values back
      // at finalize and the backend echoes `preview` on `capture/finished`,
      // so the editor-open decision rides the capture itself.
      void emitOverlayToggles({
        preview: state.preview,
        clipboard: state.clipboard,
        cursor: state.cursor,
        enhance: state.enhance,
      });
      // Mirror the scroll direction too, so the overlay's direction
      // control (Scrolling / Panoramic) starts from the user's pre-set
      // choice. Harmless for non-scroll modes.
      void emitOverlayScrollDirection(state.scrollDirection);
      // Delay branch: when the Delay toggle is on, fire the countdown
      // HUD and wait for it to either reach zero (finished) or be
      // dismissed via Esc (cancelled). Backend `start_countdown` also
      // stashes + hides the current primary window so it isn't in the
      // deferred shot; cancel restores it, finish hands the window
      // pipeline off to the capture call below.
      if (state.delayEnabled && state.delaySeconds > 0) {
        await startCountdown(state.delaySeconds);
        const outcome = await waitForCountdownOutcome();
        if (outcome === "cancelled") return null;
      }

      switch (state.captureType) {
        case "fullscreen":
          // `buildRequest` carries `toggles.preview`; the backend echoes
          // it back on `capture/finished`.
          return await captureFullscreen(buildRequest(state));
        case "region":
          // The overlay opens; the eventual capture arrives via the
          // `clippity://capture/finished` event (subscribed by toast /
          // library / the editor-open listener). The trigger resolves
          // once the overlay is shown — no immediate CaptureResult.
          await beginRegionCapture("region");
          return null;
        case "window":
          // Opens the overlay in Window mode (hover a window, click to
          // capture). Same deferred-result shape as Region.
          await beginRegionCapture("window");
          return null;
        case "custom": {
          // Object mode runs on a downloadable on-device model — gate
          // the overlay on the backend's readiness verdict. `ready`
          // falls through to the normal dispatch; `downloading` (auto-
          // download just kicked in, or a fetch was already running)
          // and `missing` (auto-download off) surface a toast instead
          // of opening an overlay that could never detect anything.
          if (state.customMode === "object") {
            const readiness = await ensureObjectModel();
            if (readiness.status === "downloading") {
              void emitErrorToast(
                `Downloading the ${readiness.model.label} model — try Object capture again in a moment.`
              );
              return null;
            }
            if (readiness.status === "missing") {
              void emitErrorToast(
                "Object capture needs an AI model. Install one under Settings → Models."
              );
              return null;
            }
          }
          // Map the selected custom mode to the overlay mode it opens.
          // Unwired modes have no mapping; their disabled tiles prevent
          // reaching this branch, so it's a silent no-op.
          const overlayMode = state.customMode
            ? CUSTOM_MODE_TO_OVERLAY[state.customMode]
            : undefined;
          if (overlayMode) {
            await beginRegionCapture(overlayMode);
          }
          return null;
        }
      }
    } catch (err) {
      const message =
        err instanceof TauriCommandError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Capture failed.";
      void emitErrorToast(message);
      return null;
    }
  }, []);

  return { trigger };
}

/**
 * Race the backend's `countdown/finished` and `countdown/cancelled`
 * events. Returns whichever fires first, then unsubscribes from both
 * so a late event doesn't leak listeners.
 *
 * Kept module-local rather than hoisted into the IPC client because
 * "wait for one of these two events, then unsubscribe" is a
 * promise-shaped convenience the trigger needs but no other consumer
 * does — putting it in the client would invite copy-paste callers
 * that forget to unsubscribe.
 */
function waitForCountdownOutcome(): Promise<"finished" | "cancelled"> {
  return new Promise((resolve) => {
    let unsubFinished: (() => void) | null = null;
    let unsubCancelled: (() => void) | null = null;
    const cleanup = (result: "finished" | "cancelled") => {
      unsubFinished?.();
      unsubCancelled?.();
      resolve(result);
    };
    unsubFinished = onCountdownFinished(() => cleanup("finished"));
    unsubCancelled = onCountdownCancelled(() => cleanup("cancelled"));
  });
}
