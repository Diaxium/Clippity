import { useCallback, useEffect, useRef, useState } from "react";

import { Mic, Pause, Play, Square } from "lucide-react";

import {
  onRecorderFinished,
  onRecorderTick,
  pauseRecording,
  recordingStatus,
  resumeRecording,
  stopRecording,
} from "@services/tauri/clients/recorder";
import type { RecorderStatus } from "@services/tauri/clients/recorder";
import type { RecorderToastFormat } from "@services/tauri/clients/toast";
import { emitErrorToast } from "@services/tauri/clients/toast";

const FORMAT_LABEL: Record<RecorderToastFormat, string> = {
  mp4: "Video",
  gif: "GIF",
};

/**
 * The video/GIF recorder HUD (ADR 0031) — a sticky, capture-excluded
 * toast that is the only way to end a running session.
 *
 * Distinct from `RecordingToastBody`, which is the scroll stitcher's:
 * that one counts frames toward a still image and offers Stop & Stitch.
 * This one runs a clock and offers pause/resume.
 *
 * **Every ending arrives through `recorder/finished`.** A session can
 * end without anyone pressing Stop — it can hit its format's duration
 * ceiling, or the encoder can fail — so the HUD treats the event, not
 * the button, as the source of truth and calls `stopRecording` to reap
 * whichever way it got there. Handling only the button would leave a
 * dead HUD on screen after a self-stop.
 */
export function RecorderToastBody({
  format,
  audio,
}: {
  format: RecorderToastFormat;
  audio: boolean;
}) {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  // A session is reaped exactly once. The Stop button, the Discard
  // button and the finished event can all race each other here.
  const reaped = useRef(false);

  const reap = useCallback((discard: boolean) => {
    if (reaped.current) return;
    reaped.current = true;
    void stopRecording(discard).catch((err: unknown) =>
      emitErrorToast(
        err instanceof Error ? err.message : "Failed to finish the recording."
      )
    );
  }, []);

  useEffect(() => {
    // The HUD can mount after the session started (the toast window is
    // persistent and re-renders), so ask for the current status rather
    // than showing 00:00 until the first tick lands.
    void recordingStatus()
      .then(setStatus)
      .catch(() => {
        /* A session that already ended has nothing to report. */
      });

    const offTick = onRecorderTick(setStatus);
    const offFinished = onRecorderFinished(() => reap(false));
    return () => {
      offTick();
      offFinished();
    };
  }, [reap]);

  const paused = status?.state === "paused";
  const toggle = useCallback(() => {
    const next = paused ? resumeRecording : pauseRecording;
    void next()
      .then(setStatus)
      .catch((err: unknown) =>
        emitErrorToast(
          err instanceof Error ? err.message : "Could not pause the recording."
        )
      );
  }, [paused]);

  return (
    <div className="flex flex-col gap-2 p-1.5">
      <div className="float-card flex flex-col gap-2.5 rounded-[12px] border border-[color:var(--hairline)] p-3.5 shadow-[var(--shadow-modal)] backdrop-blur-md">
        <span className="flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--color-hint)]">
          {/* The dot stops pulsing while paused — the one glanceable
              signal that the clock is not running. */}
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              paused
                ? "bg-[var(--color-hint)]"
                : "animate-pulse bg-[var(--color-accent)]"
            }`}
          />
          {paused ? "Paused" : "Recording"} · {FORMAT_LABEL[format]}
          {audio ? (
            <Mic size={11} strokeWidth={2.5} className="ml-auto shrink-0" />
          ) : null}
        </span>

        <span className="font-mono text-[26px] font-semibold leading-none tracking-tight text-[var(--color-ink)] tabular-nums">
          {formatElapsed(status?.elapsedMs ?? 0)}
        </span>

        <span className="text-[11px] text-[var(--color-hint)]">
          {formatDetail(status)}
        </span>
      </div>

      <div className="float-card flex items-center justify-between gap-2 rounded-[12px] border border-[color:var(--hairline)] px-3.5 py-2.5 shadow-[var(--shadow-modal)] backdrop-blur-md">
        <button
          type="button"
          onClick={() => reap(true)}
          className="rounded-[9px] px-2 py-1 text-[11.5px] font-medium text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
        >
          Discard
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggle}
            aria-label={paused ? "Resume recording" : "Pause recording"}
            className="inline-flex items-center gap-1.5 rounded-[9px] px-2.5 py-1 text-[11.5px] font-medium text-[var(--color-slate)] transition-colors hover:bg-[color:var(--color-overlay-1)] hover:text-[var(--color-ink)]"
          >
            {paused ? (
              <Play size={11} strokeWidth={2.5} className="fill-current" />
            ) : (
              <Pause size={11} strokeWidth={2.5} className="fill-current" />
            )}
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            onClick={() => reap(false)}
            className="inline-flex items-center gap-1.5 rounded-[9px] bg-[var(--color-accent)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--color-accent-ink)] transition-[filter] hover:brightness-105"
          >
            <Square size={11} strokeWidth={2.5} className="fill-current" />
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * `mm:ss`, or `h:mm:ss` once a recording passes an hour.
 *
 * This is *recorded* time, not time since the user pressed record — the
 * backend's clock holds while paused, because the number shown here is
 * a promise about the length of the resulting file.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The secondary line: size so far, and dropped frames **only when there
 * are any**.
 *
 * A permanent "0 dropped" would train users to ignore the number; it
 * appearing is the signal to lower the frame rate.
 */
export function formatDetail(status: RecorderStatus | null): string {
  if (!status) return "Starting…";
  const parts = [formatBytes(status.bytes)];
  if (status.dropped > 0) {
    parts.push(`${status.dropped} dropped`);
  }
  return parts.join(" · ");
}

/** Human-readable byte size, one decimal from MB up. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
