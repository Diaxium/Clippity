import { useCallback, useEffect, useState } from "react";

import {
  mediaCancelTrim,
  mediaStageOverlay,
  mediaTrim,
  onTrimProgress,
  type TrimProgress,
  type TrimResult,
} from "@services/tauri/clients/media";
import type { RecorderFormat } from "@clippity/shared";

import { toRedactions } from "../lib/annotations";
import { renderOverlays } from "../lib/exportOverlays";
import { useStudioStore } from "../state/studioStore";

export interface TrimExportState {
  /** Non-null while an export is running. */
  progress: TrimProgress | null;
  /** The last successful export, until the range changes. */
  done: TrimResult | null;
  error: string | null;
  running: boolean;
  start(format: RecorderFormat, mute: boolean): void;
  cancel(): void;
}

/**
 * Drive a trim export and report where it has got to.
 *
 * Deliberately not in the store. The store is the *document* — what clip
 * is open, where the playhead is, where the handles are — and it is read
 * by every control on the surface. An export is a transient job with one
 * consumer, and putting its progress in the store would re-render the
 * timeline and the transport several times a second for the length of an
 * encode, to update a label neither of them shows.
 */
export function useTrimExport(): TrimExportState {
  const id = useStudioStore((s) => s.id);
  const range = useStudioStore((s) => s.range);
  const [progress, setProgress] = useState<TrimProgress | null>(null);
  const [done, setDone] = useState<TrimResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = progress !== null;

  // Subscribe once, not per export: the listener registers
  // asynchronously, so setting it up inside `start` would race the first
  // few progress events and the bar would jump rather than fill.
  useEffect(() => onTrimProgress(setProgress), []);

  // A finished export describes the range it was made from. Once the
  // handles move it is describing something else, so it stops being
  // shown rather than quietly mislabelling the new selection.
  useEffect(() => {
    setDone(null);
    setError(null);
  }, [range.startMs, range.endMs, id]);

  const start = useCallback(
    (format: RecorderFormat, mute: boolean) => {
      if (!id || running) return;
      setError(null);
      setDone(null);
      // Seed the progress so the UI switches to its running state on the
      // click rather than when the first event lands — an encode can
      // take a moment to produce its first frame.
      setProgress({ encodedMs: 0, totalMs: range.endMs - range.startMs });

      const startMs = Math.round(range.startMs);
      const endMs = Math.round(range.endMs);

      void (async () => {
        // Read the annotations at the moment Export is pressed rather
        // than closing over them: the store is the document, and a
        // stale set here would export a picture the user has since
        // changed.
        const { annotations, info } = useStudioStore.getState();

        // Overlays are rendered at the source's **native** size, not the
        // stage's — the backend composites them onto decoded frames, and
        // a stage-sized overlay would cover a corner of the picture.
        const overlays = info
          ? await renderOverlays(annotations, {
              width: info.width,
              height: info.height,
              fromMs: startMs,
              toMs: endMs,
              stage: mediaStageOverlay,
            })
          : [];

        return mediaTrim({
          id,
          startMs,
          endMs,
          format,
          mute,
          // Both are timed against the source, which is where the user
          // placed them — the backend looks them up by each frame's own
          // timestamp rather than by its position in the export.
          redactions: toRedactions(annotations),
          overlays,
        });
      })()
        .then(setDone)
        .catch((err: unknown) =>
          setError(err instanceof Error ? err.message : "The export failed.")
        )
        .finally(() => setProgress(null));
    },
    [id, range.startMs, range.endMs, running]
  );

  const cancel = useCallback(() => {
    // The command only *asks*; the running `mediaTrim` promise rejects
    // and clears the progress. Doing it here as well would show an idle
    // UI over an encode that is still unwinding.
    void mediaCancelTrim().catch(() => {
      /* nothing to cancel */
    });
  }, []);

  return { progress, done, error, running, start, cancel };
}
