/**
 * Screen-recording wire-format contracts — mirror Rust
 * `domain::recorder`.
 *
 * Distinct from `scroll.ts` on purpose: that module's "recording" is
 * the Scrolling-Window / Panoramic stitcher, which produces a still
 * image. This one produces a video or GIF. Same silhouette (start,
 * tick, stop-or-discard), different pipeline, separate events.
 */

import type { Source } from "./composition";

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
  /** Level each input is mixed at, as a percentage of unity — 100 is
   *  unchanged, 0 is silence, 200 is the ceiling. Percentages rather
   *  than a multiplier because that is the unit the slider shows and it
   *  round-trips through JSON exactly. Omitted = 100. */
  microphoneGainPct?: number;
  systemGainPct?: number;
}

/** Which input a gain, a mute or a level reading refers to. */
export type AudioSource = "microphone" | "system";

/**
 * Peak level of each input since the previous reading, `0..=1`, carried
 * on `clippity://recorder/levels` roughly ten times a second while a
 * session has audio.
 *
 * Peak rather than RMS: a recording meter answers "is this live" and "is
 * it clipping", and both are peak questions. A session with no audio
 * emits this not at all, so the HUD shows meters only when there is
 * something to meter.
 */
export interface RecorderLevels {
  microphone: number;
  system: number;
}

/**
 * Recording toggles. Not `CaptureToggles` — `enhance` is meaningless for
 * a frame stream, `clicks` has no still equivalent, and `clipboard`
 * means something different here (see below). `clicks` implies `cursor`
 * (the backend turns it on rather than rejecting the pair).
 */
export interface RecorderToggles {
  cursor: boolean;
  clicks: boolean;
  /** Open the finished recording in the library inspector — the
   *  recorder's counterpart to "Preview in Editor". */
  preview: boolean;
  /** Put the finished clip on the clipboard as a file reference
   *  (`CF_HDROP`), not as bytes — which is what makes it viable for a
   *  video, and what makes it paste as an attachment. The clipboard
   *  names a path, so moving the clip before pasting breaks it. */
  clipboard: boolean;
}

/**
 * How generously the H.264 encoder is budgeted — a multiplier on the
 * bits-per-pixel-per-frame target the backend derives from the frame
 * size and rate.
 *
 * Named steps rather than a raw bitrate box, because the right bitrate
 * depends on resolution and frame rate: the same 8 Mbps that is generous
 * for a 720p region starves a 4K desktop. `balanced` is what every
 * recording made before this setting existed used.
 */
export type RecorderQuality = "efficient" | "balanced" | "high";

/**
 * How the encoder may spend its bitrate over time. `variable` lets the
 * long motionless stretches of a screen recording cost almost nothing;
 * `constant` trades that saving for a predictable size per minute.
 */
export type RateControl = "variable" | "constant";

/**
 * H.264 encoder settings. **Ignored entirely by the GIF path**, which is
 * a palettized per-frame format with no bitrate, keyframes or rate
 * control.
 *
 * Every field is optional on the wire and defaults backend-side, so an
 * older preset or a partial patch stays valid.
 */
export interface RecorderEncoding {
  quality?: RecorderQuality;
  /** Fixed average bitrate in bits per second, overriding what `quality`
   *  would derive. Omitted / null / 0 derives. Clamped backend-side to
   *  1.5–60 Mbps whether typed or derived. */
  bitrateBps?: number | null;
  /** Seconds between keyframes (1–10, default 2). A decoder can only
   *  start at a keyframe, so this is the granularity Studio's scrubber
   *  can seek to — not a cosmetic setting. */
  keyframeSeconds?: number;
  rateControl?: RateControl;
  /** Prefer the GPU's encoder. On by default; software encode cannot
   *  keep up at 4K60. Turning it off is the escape hatch for a driver
   *  that encodes visibly worse than the software path. */
  preferHardware?: boolean;
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
  /** Cap on the encoded frame's height, in pixels. Omit / null / `0` to
   *  encode at the captured size. Never upscales, and preserves the
   *  aspect ratio; GIF's own pixel budget still applies on top. */
  maxHeight?: number | null;
  audio?: AudioSelection;
  /** H.264 encoder settings. Ignored for `gif`. */
  encoding?: RecorderEncoding;
  /** Things composited over the captured frame — a webcam, a logo
   *  (ADR 0033). Order is meaningful: later sources draw over earlier
   *  ones. Applies to both formats. */
  sources?: Source[];
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
  "committed" | "discarded" | "duration-limit" | "failed";
