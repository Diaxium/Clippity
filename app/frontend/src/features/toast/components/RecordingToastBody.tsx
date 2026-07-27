import { useCallback, useEffect, useRef, useState } from "react";

import { Square } from "lucide-react";

import {
  onRecordingAutoStop,
  onRecordingPreview,
  onRecordingTick,
  stopScrollCapture,
} from "@services/tauri/clients/scroll";
import type { RecordingMode } from "@services/tauri/clients/toast";
import { emitErrorToast } from "@services/tauri/clients/toast";

const MODE_LABEL: Record<RecordingMode, string> = {
  scrolling: "Scrolling Window",
  panoramic: "Panoramic",
};

/**
 * The Scrolling-Window recording HUD (ADR 0008). Renders as two separate
 * floating cards inside the (transparent, chrome-less) toast window: a
 * **status + live-preview** card on top, and a **controls bar** below it
 * (frame count + **Stop & Stitch** / **Discard**).
 *
 * The preview sits in a fixed-height box so the window keeps a constant
 * size — the controls bar stays pinned and is never shoved around by the
 * growing stitch above it. Tick / preview / auto-stop all arrive via
 * `recording/*` events; the backend tears the toast down on stop (so a
 * worker can't be orphaned) and the HUD auto-commits on
 * `recording/auto-stop` (the user reversed scroll direction).
 */
export function RecordingToastBody({
  mode,
  frames: initialFrames,
}: {
  mode: RecordingMode;
  frames: number;
}) {
  const [frames, setFrames] = useState(initialFrames);
  const [preview, setPreview] = useState<string | null>(null);
  // A session commits or discards exactly once; the buttons and the
  // auto-stop event all funnel through `stop`, so guard against a double
  // stop (e.g. a manual click racing the reversal event).
  const stopped = useRef(false);

  const stop = useCallback((discard: boolean) => {
    if (stopped.current) return;
    stopped.current = true;
    void stopScrollCapture(discard).catch((err: unknown) =>
      emitErrorToast(
        err instanceof Error ? err.message : "Failed to finish recording."
      )
    );
  }, []);

  useEffect(() => {
    const offTick = onRecordingTick((e) => setFrames(e.frames));
    const offPreview = onRecordingPreview((e) => setPreview(e.dataUri));
    // Reversing scroll direction is the natural "I'm done" signal — the
    // worker emits this and we commit, exactly as Stop & Stitch would.
    const offAutoStop = onRecordingAutoStop(() => stop(false));
    return () => {
      offTick();
      offPreview();
      offAutoStop();
    };
  }, [stop]);

  return (
    <div className="flex flex-col gap-2 p-1.5">
      {/* Status + live preview. The preview is boxed at a fixed height so
          the window never resizes as the stitch grows. */}
      <div className="float-card flex flex-col gap-2 overflow-hidden rounded-[12px] border border-[color:var(--hairline)] p-3.5 shadow-[var(--shadow-modal)] backdrop-blur-md">
        <span className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--color-accent)]" />
          Recording · {MODE_LABEL[mode]}
        </span>
        <div className="flex h-40 w-full items-center justify-center overflow-hidden rounded-[8px] border border-[color:var(--hairline)] bg-[color:var(--color-overlay-1)]">
          {preview ? (
            <img
              src={preview}
              alt="Live stitch preview"
              className="h-full w-full object-contain"
              draggable={false}
            />
          ) : (
            <span className="text-[11px] text-[var(--color-hint)]">
              {mode === "panoramic" ? "Auto-scrolling…" : "Scroll to capture"}
            </span>
          )}
        </div>
      </div>

      {/* Controls bar — a separate floating card below the preview, fixed
          in place and unaffected by the live preview above it. */}
      <div className="float-card flex items-center justify-between gap-2 rounded-[12px] border border-[color:var(--hairline)] px-3.5 py-2.5 shadow-[var(--shadow-modal)] backdrop-blur-md">
        <span className="text-[11.5px] text-[var(--color-slate)]">
          {frames} {frames === 1 ? "frame" : "frames"} ·{" "}
          {mode === "panoramic" ? "auto-scrolling" : "scroll the content"}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => stop(true)}
            className="rounded-[9px] px-2 py-1 text-[11.5px] font-medium text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => stop(false)}
            className="inline-flex items-center gap-1.5 rounded-[9px] bg-[var(--color-accent)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--color-accent-ink)] transition-[filter] hover:brightness-105"
          >
            <Square size={11} strokeWidth={2.5} className="fill-current" />
            Stop &amp; Stitch
          </button>
        </div>
      </div>
    </div>
  );
}
