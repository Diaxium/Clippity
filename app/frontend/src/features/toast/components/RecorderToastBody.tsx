import { useCallback, useEffect, useRef, useState } from "react";

import {
  Mic,
  MicOff,
  Pause,
  Play,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";

import {
  onRecorderFinished,
  onRecorderLevels,
  onRecorderTick,
  pauseRecording,
  recordingStatus,
  resumeRecording,
  setRecordingGain,
  setRecordingMute,
  stopRecording,
} from "@services/tauri/clients/recorder";
import type {
  AudioSource,
  RecorderLevels,
  RecorderStatus,
} from "@services/tauri/clients/recorder";
import type { RecorderToastFormat } from "@services/tauri/clients/toast";
import { emitErrorToast } from "@services/tauri/clients/toast";

const FORMAT_LABEL: Record<RecorderToastFormat, string> = {
  mp4: "Video",
  gif: "GIF",
};

/** Gain envelope, mirroring `domain::recorder::GAIN_PCT_*`. */
const GAIN_MAX_PCT = 200;
const GAIN_DEFAULT_PCT = 100;

const SILENT: RecorderLevels = { microphone: 0, system: 0 };

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
  microphone,
  system,
}: {
  format: RecorderToastFormat;
  microphone: boolean;
  system: boolean;
}) {
  const [status, setStatus] = useState<RecorderStatus | null>(null);
  const [levels, setLevels] = useState<RecorderLevels>(SILENT);
  const audio = microphone || system;
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
    const offLevels = onRecorderLevels(setLevels);
    const offFinished = onRecorderFinished(() => reap(false));
    return () => {
      offTick();
      offLevels();
      offFinished();
    };
  }, [reap]);

  const paused = status?.state === "paused";

  // A paused session hears nothing, and the backend zeroes the meters
  // when it pauses — but the last event can land either side of the
  // transition, so the render pins them too rather than leaving a bar
  // frozen mid-height on a session that stopped listening.
  const shown = paused ? SILENT : levels;
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

      {audio && (
        <div className="float-card flex flex-col gap-1.5 rounded-[12px] border border-[color:var(--hairline)] px-3.5 py-2.5 shadow-[var(--shadow-modal)] backdrop-blur-md">
          {microphone && (
            <MixerRow
              source="microphone"
              label="Microphone"
              level={shown.microphone}
              OnIcon={Mic}
              OffIcon={MicOff}
            />
          )}
          {system && (
            <MixerRow
              source="system"
              label="System audio"
              level={shown.system}
              OnIcon={Volume2}
              OffIcon={VolumeX}
            />
          )}
        </div>
      )}

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
 * One input's live strip: mute, a peak meter, and a level slider.
 *
 * **Level state is local, and that is deliberate.** The backend owns the
 * session's gain and there is no event reporting it back, so this is the
 * only writer — which is what lets a drag stay smooth instead of
 * fighting a value echoed back a frame later. Every session starts from
 * the persisted default, so the local state is never stale on mount.
 *
 * Mute is separate from dragging to zero: it remembers the level to come
 * back to, which is the thing a slider alone cannot do.
 */
function MixerRow({
  source,
  label,
  level,
  OnIcon,
  OffIcon,
}: {
  source: AudioSource;
  label: string;
  level: number;
  OnIcon: typeof Mic;
  OffIcon: typeof MicOff;
}) {
  const [gain, setGain] = useState(GAIN_DEFAULT_PCT);
  const [muted, setMuted] = useState(false);

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    // Fire-and-forget: the command is infallible backend-side and a
    // session that ended mid-click is a race, not something to put an
    // error toast on screen about.
    void setRecordingMute(source, next);
  };

  const commit = (pct: number) => {
    setGain(pct);
    // Un-mute implicitly: moving the slider is an unambiguous request
    // for that level, and leaving it silent would read as a dead
    // control.
    if (muted) setMuted(false);
    void setRecordingGain(source, pct);
  };

  const Icon = muted ? OffIcon : OnIcon;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={toggleMute}
        aria-label={`${muted ? "Unmute" : "Mute"} ${label.toLowerCase()}`}
        aria-pressed={muted}
        className={`grid h-6 w-6 shrink-0 place-items-center rounded-[7px] transition-colors hover:bg-[color:var(--color-overlay-1)] ${
          muted ? "text-[var(--color-danger)]" : "text-[var(--color-slate)]"
        }`}
      >
        <Icon size={12} strokeWidth={2.25} />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {/* Meter above the slider so the bar the user is watching does
            not sit under the thumb they are dragging. */}
        <div
          className="h-1 w-full overflow-hidden rounded-full bg-[color:var(--color-overlay-1)]"
          role="meter"
          aria-label={`${label} level`}
          aria-valuenow={Math.round(level * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-100 ${
              // Red from -3 dBFS up: the point where the next transient
              // is the one that clips.
              level > 0.71
                ? "bg-[var(--color-danger)]"
                : "bg-[var(--color-accent)]"
            }`}
            style={{ width: `${Math.min(100, level * 100)}%` }}
          />
        </div>
        <input
          type="range"
          className="clippity-slider h-1 w-full"
          min={0}
          max={GAIN_MAX_PCT}
          step={5}
          value={muted ? 0 : gain}
          aria-label={`${label} volume`}
          onChange={(e) => commit(Number(e.currentTarget.value))}
        />
      </div>

      <span className="w-8 shrink-0 text-right font-mono text-[10px] text-[var(--color-hint)] tabular-nums">
        {muted ? "—" : `${gain}%`}
      </span>
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
