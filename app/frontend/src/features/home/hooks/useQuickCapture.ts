/**
 * Quick-capture dispatch — turns a `QuickCaptureId` into the matching
 * backend call. Shared by the Home launcher cards, the header Capture
 * button, and the keyboard shortcuts so all three entry points fire the
 * exact same flow.
 *
 * Screenshot → region overlay, Window → window overlay (both open the
 * overlay; the finished capture arrives later via
 * `clippity://capture/finished`, handled by toast / library / the
 * editor-open listener).
 *
 * Record and GIF start a recording on the monitor under the cursor
 * (ADR 0031) and raise the recorder HUD, which owns stopping it. They
 * are one call apart because format is the only thing that differs — a
 * session is captured once and fed to whichever encoder the format
 * selected.
 */

import { useCallback } from "react";

import { useSettingsStore } from "@features/settings";
import { beginRegionCapture } from "@services/tauri/clients/overlay";
import { startRecording } from "@services/tauri/clients/recorder";
import type { RecorderFormat } from "@services/tauri/clients/recorder";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { buildRecorderRequest } from "@shared/lib/recorderRequest";

import type { QuickCaptureId } from "../lib/quickCapture";

export function useQuickCapture(): (id: QuickCaptureId) => void {
  const recording = useSettingsStore((s) => s.settings?.recording);

  /** Start a fullscreen recording, surfacing a failure as a toast — the
   *  launcher has nowhere else to report one. */
  const record = useCallback(
    (format: RecorderFormat) => {
      void startRecording(
        buildRecorderRequest("fullscreen", format, recording)
      ).catch(
        (err: unknown) =>
          emitErrorToast(
            err instanceof Error
              ? err.message
              : "Couldn't start the recording."
          )
      );
    },
    [recording]
  );

  return useCallback(
    (id: QuickCaptureId) => {
      switch (id) {
        case "screenshot":
          void beginRegionCapture("region").catch((err) =>
            emitErrorToast(
              err instanceof Error ? err.message : "Couldn't start the capture."
            )
          );
          return;
        case "window":
          void beginRegionCapture("window").catch((err) =>
            emitErrorToast(
              err instanceof Error ? err.message : "Couldn't start the capture."
            )
          );
          return;
        case "record":
          record("mp4");
          return;
        case "gif":
          record("gif");
          return;
      }
    },
    [record]
  );
}
