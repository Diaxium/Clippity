/**
 * Screen-recording wire-format contracts — mirror Rust
 * `domain::recorder`.
 *
 * Distinct from `scroll.ts` on purpose: that module's "recording" is
 * the Scrolling-Window / Panoramic stitcher, which produces a still
 * image. This one produces a video or GIF. Same silhouette (start,
 * tick, stop-or-discard), different pipeline, separate events.
 */

/** What surface the session records. */
export type RecorderTarget = "region" | "window" | "fullscreen";

/**
 * Output format, chosen before the session starts — the only fork in
 * the pipeline. One capture session feeds one of two encoders.
 */
export type RecorderFormat = "mp4" | "gif";

/**
 * Which audio inputs to mix in. Both can be on at once (narrating over
 * system sound), and each degrades independently — a denied microphone
 * must not cost the user their system audio. A `null` device id follows
 * the OS default. Ignored entirely for `gif`, which has no audio track.
 */
export interface AudioSelection {
  microphone: boolean;
  system: boolean;
  microphoneDevice?: string | null;
  systemDevice?: string | null;
}

/**
 * Recording toggles. Not `CaptureToggles` — `enhance` and `clipboard`
 * are meaningless for a frame stream, and `clicks` has no still
 * equivalent. `clicks` implies `cursor` (the backend turns it on rather
 * than rejecting the pair).
 */
export interface RecorderToggles {
  cursor: boolean;
  clicks: boolean;
  /** Open the finished recording in the library inspector — the
   *  recorder's counterpart to "Preview in Editor". */
  preview: boolean;
}

/** Payload sent to `start_recording`. */
export interface RecorderRequest {
  target: RecorderTarget;
  /** Physical-pixel rect on the virtual desktop. Required for `region`
   *  and `window`; omitted for `fullscreen`, where the backend resolves
   *  the monitor. */
  region?: { x: number; y: number; width: number; height: number } | null;
  /** Source window's HWND bits, for `window` targets. */
  windowId?: number | null;
  format: RecorderFormat;
  /** Omit for the format's default. Out-of-range values are clamped by
   *  the backend, not rejected. */
  fps?: number | null;
  audio?: AudioSelection;
  toggles?: RecorderToggles;
  /** Save-directory override (preset "save to"). Omitted / null = the
   *  live captures dir. */
  outputDir?: string | null;
  /** Name of the preset that started this recording, for its provenance
   *  sidecar. Omitted / null = started interactively. */
  preset?: string | null;
}

export type RecorderState = "idle" | "recording" | "paused";

/**
 * Live session status — carried on `recorder/tick` and returned by the
 * start/pause/resume commands so the HUD can render before the first
 * tick lands.
 *
 * `elapsedMs` is *recorded* time, not wall-clock since start: a paused
 * session's timer holds, because the number the HUD shows is a promise
 * about the length of the file.
 */
export interface RecorderStatus {
  state: RecorderState;
  elapsedMs: number;
  frames: number;
  /** Frames the encoder couldn't keep up with. Shown, not just logged —
   *  a climbing count is what tells a user to lower the frame rate. */
  dropped: number;
  /** Bytes on disk so far. Always 0 for GIF, which has nothing on disk
   *  until the quantization pass at stop. */
  bytes: number;
}

/** What `stop_recording` returns and what `recorder/finished` carries. */
export interface RecorderResult {
  id: string;
  target: RecorderTarget;
  format: RecorderFormat;
  width: number;
  height: number;
  /** Absolute on-disk path to the saved recording. */
  path: string;
  durationMs: number;
  frames: number;
  /** Whether an audio track was actually written — not merely requested.
   *  A denied microphone lands here as `false` so the toast can say so
   *  instead of the user finding the silence on playback. */
  hasAudio: boolean;
  preview: boolean;
}

/** Why a session ended. Only `committed` (and the two salvage cases)
 *  produce a `RecorderResult`; `discarded` deletes the partial file. */
export type RecorderStopReason =
  | "committed"
  | "discarded"
  | "duration-limit"
  | "failed";
