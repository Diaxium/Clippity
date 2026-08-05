import { emit } from "@tauri-apps/api/event";

import { EVENT_NAMES, invoke, on } from "@services/tauri";

import type {
  AudioSource,
  WebcamDeviceInfo,
  RecorderFormat,
  RecorderLevels,
  RecorderRequest,
  RecorderResult,
  RecorderStatus,
  RecorderStopReason,
} from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::recorder`) ----------
export type {
  AudioSelection,
  AudioSource,
  Source,
  SourceKind,
  WebcamDeviceInfo,
  RateControl,
  RecorderEncoding,
  RecorderFormat,
  RecorderLevels,
  RecorderQuality,
  RecorderRequest,
  RecorderResult,
  RecorderState,
  RecorderStatus,
  RecorderStopReason,
  RecorderTarget,
  RecorderToggles,
} from "@clippity/shared";

/** Cameras available as a recording source. An empty list is a valid
 *  answer — a machine with no camera is a configuration, not an error. */
export function listWebcams(): Promise<WebcamDeviceInfo[]> {
  return invoke<WebcamDeviceInfo[]>("list_webcams");
}

/** An audio endpoint offered by the backend for the settings UI. */
export interface AudioDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

/** Payload of `clippity://recorder/finished`. `result` is null for a
 *  discard, or a session that never captured a frame. */
export interface RecorderFinished {
  reason: RecorderStopReason;
  result: RecorderResult | null;
}

/**
 * Start a video / GIF recording (ADR 0031).
 *
 * One session, two outputs: `request.format` picks the encoder the
 * frames are fed to; everything else about the session is identical.
 * Raises the recorder HUD as a sticky toast and returns the opening
 * status so the HUD can render before the first tick.
 */
export function startRecording(
  request: RecorderRequest
): Promise<RecorderStatus> {
  return invoke<RecorderStatus, { request: RecorderRequest }>(
    "start_recording",
    { request }
  );
}

/** Hold the recording. The session clock stops, so the finished file's
 *  timeline has no frozen stretch in it. */
export function pauseRecording(): Promise<RecorderStatus> {
  return invoke<RecorderStatus>("pause_recording");
}

export function resumeRecording(): Promise<RecorderStatus> {
  return invoke<RecorderStatus>("resume_recording");
}

/** Current status — lets a HUD that mounted late catch up without
 *  waiting for the next tick. */
export function recordingStatus(): Promise<RecorderStatus> {
  return invoke<RecorderStatus>("recording_status");
}

/**
 * Move one input's level on the running session, as a percentage of
 * unity (0–200; the backend clamps).
 *
 * Resolves even when nothing is recording, unlike `pauseRecording` — a
 * slider release that lands just after a session ended is a race, not an
 * error worth putting a toast on screen for.
 *
 * Live-session only. The persisted default is a `RecordingSettings`
 * patch, deliberately separate.
 */
export function setRecordingGain(
  source: AudioSource,
  pct: number
): Promise<void> {
  return invoke<void, { source: AudioSource; pct: number }>(
    "set_recording_gain",
    { source, pct }
  );
}

/** Mute or unmute one input on the running session; unmuting restores
 *  the level it had before. Same no-op-when-idle rule as
 *  `setRecordingGain`. */
export function setRecordingMute(
  source: AudioSource,
  muted: boolean
): Promise<void> {
  return invoke<void, { source: AudioSource; muted: boolean }>(
    "set_recording_mute",
    { source, muted }
  );
}

/**
 * Stop the recording. `discard` deletes the working file; otherwise it
 * is saved into the captures directory. Resolves to `null` for a
 * discard, or when nothing was recording.
 */
export function stopRecording(
  discard: boolean
): Promise<RecorderResult | null> {
  return invoke<RecorderResult | null, { discard: boolean }>("stop_recording", {
    discard,
  });
}

/**
 * Audio endpoints for the settings UI. `system: true` lists render
 * endpoints (captured in loopback); otherwise microphones. An empty
 * list is a valid answer — a machine with no microphone is a
 * configuration, not an error.
 */
export function listAudioDevices(system: boolean): Promise<AudioDeviceInfo[]> {
  return invoke<AudioDeviceInfo[], { system: boolean }>("list_audio_devices", {
    system,
  });
}

/**
 * Capture-window → overlay mirror of the chosen recording format.
 *
 * A region or window recording is started *from the overlay*, which is
 * a different window and has no idea what the Record screen selected.
 * Sent just before opening the overlay, exactly as the scroll direction
 * is mirrored for Scrolling/Panoramic. Frontend-to-frontend — no
 * backend leg.
 */
export async function emitOverlayRecordFormat(
  format: RecorderFormat
): Promise<void> {
  await emit(EVENT_NAMES.overlayRecordFormat, format);
}

/** Overlay-side listener for the mirrored recording format. */
export function onOverlayRecordFormat(
  handler: (format: RecorderFormat) => void
): () => void {
  return on<RecorderFormat>(EVENT_NAMES.overlayRecordFormat, handler);
}

/**
 * Mirror a recording **preset's** request to the overlay — everything
 * but the rectangle, which is what the overlay is about to pick.
 *
 * The format mirror above is not enough for a preset: a preset also
 * carries its own frame rate, resolution cap, audio selection and
 * encoder settings, and the overlay's finalize would otherwise rebuild
 * all of that from live settings and silently discard them.
 *
 * **Send `null` on every non-preset open.** The overlay keeps whatever
 * it was last told, so an unsent null means the next ordinary region
 * recording quietly inherits the last preset's configuration.
 */
export async function emitOverlayRecordPreset(
  request: RecorderRequest | null
): Promise<void> {
  await emit(EVENT_NAMES.overlayRecordPreset, request);
}

/** Overlay-side listener for the mirrored preset request. */
export function onOverlayRecordPreset(
  handler: (request: RecorderRequest | null) => void
): () => void {
  return on<RecorderRequest | null>(EVENT_NAMES.overlayRecordPreset, handler);
}

/** Roughly twice a second while a session runs. Drives the HUD's timer,
 *  frame count, dropped count and size readout. */
export function onRecorderTick(cb: (e: RecorderStatus) => void): () => void {
  return on<RecorderStatus>(EVENT_NAMES.recorderTick, cb);
}

/** Audio peak levels, roughly ten times a second while a session has
 *  audio. Never fires for a session with no audio, so a HUD that sees
 *  nothing here correctly shows no meters. */
export function onRecorderLevels(cb: (e: RecorderLevels) => void): () => void {
  return on<RecorderLevels>(EVENT_NAMES.recorderLevels, cb);
}

/** Fires once when a session ends, whatever the reason — including a
 *  duration limit the worker hit on its own, which no caller asked for
 *  and which the HUD must still react to. */
export function onRecorderFinished(
  cb: (e: RecorderFinished) => void
): () => void {
  return on<RecorderFinished>(EVENT_NAMES.recorderFinished, cb);
}
