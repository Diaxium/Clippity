import { useCallback } from "react";

import { useSettingsStore } from "@features/settings";
import { beginRegionCapture } from "@services/tauri/clients/overlay";
import {
  emitOverlayRecordFormat,
  emitOverlayRecordPreset,
  startRecording,
} from "@services/tauri/clients/recorder";
import type { RecorderStatus } from "@services/tauri/clients/recorder";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { buildRecorderRequest } from "@shared/lib/recorderRequest";

import { useCaptureStore } from "../state/captureStore";
import { OVERLAY_MODE_FOR_TARGET, recordReadiness } from "../recordModes";

interface UseRecordWorkflow {
  /** Start a session from the current Record-screen selection.
   *
   *  Resolves to the opening status for Fullscreen, which starts
   *  immediately. Region and Window resolve to `null`: they open the
   *  overlay, and the session doesn't exist until the user has picked
   *  something there. Also `null` when the selection can't start. */
  trigger: () => Promise<RecorderStatus | null>;
}

/**
 * Record-screen workflow dispatch — the counterpart to
 * `useCaptureWorkflow`.
 *
 * Much thinner than that hook, and for a structural reason: a recording
 * has no countdown, no clipboard, no editor handoff and (today) no
 * overlay round-trip. It starts, the HUD takes over, and everything
 * after that belongs to `RecorderToastBody`. The backend raises that
 * HUD itself, so there is nothing to arm here.
 *
 * Errors surface as toasts, matching the capture workflow — the Record
 * screen has no inline error slot, and the window is usually about to
 * lose focus anyway.
 */
export function useRecordWorkflow(): UseRecordWorkflow {
  const target = useCaptureStore((s) => s.recordTarget);
  const format = useCaptureStore((s) => s.recordFormat);
  const recording = useSettingsStore((s) => s.settings?.recording);

  const trigger = useCallback(async (): Promise<RecorderStatus | null> => {
    // The footer disables itself for an unavailable selection; this is
    // the backstop for the Space shortcut, which has no such state.
    const { ready, reason } = recordReadiness(target, format);
    if (!ready) {
      if (reason) void emitErrorToast(reason);
      return null;
    }

    const overlayMode = OVERLAY_MODE_FOR_TARGET[target];
    try {
      if (overlayMode) {
        // Region / Window need a rectangle first. Mirror the chosen
        // format across before opening — the overlay is a different
        // window and cannot see this screen's selection — then hand off:
        // the overlay's own finalize starts the session and raises the
        // HUD, so there is no status to return here.
        await emitOverlayRecordFormat(format);
        // Null, explicitly: the overlay keeps whatever it was last told,
        // so skipping this would make the next Record-Region session
        // silently inherit the last recording preset's configuration.
        await emitOverlayRecordPreset(null);
        await beginRegionCapture(overlayMode);
        return null;
      }
      return await startRecording(
        buildRecorderRequest(target, format, recording)
      );
    } catch (err: unknown) {
      void emitErrorToast(
        err instanceof Error ? err.message : "Couldn't start the recording."
      );
      return null;
    }
  }, [target, format, recording]);

  return { trigger };
}
