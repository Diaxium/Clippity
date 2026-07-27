import { emit } from "@tauri-apps/api/event";

import { EVENT_NAMES, invoke, on } from "@services/tauri";

import type {
  RecorderFormat,
  RecorderRequest,
  RecorderResult,
  RecorderStatus,
  RecorderStopReason,
} from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::recorder`) ----------
export type {
  AudioSelection,
  RecorderFormat,
  RecorderRequest,
  RecorderResult,
  RecorderState,
  RecorderStatus,
  RecorderStopReason,
  RecorderTarget,
  RecorderToggles,
} from "@clippity/shared";

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
 * Stop the recording. `discard` deletes the working file; otherwise it
 * is saved into the captures directory. Resolves to `null` for a
 * discard, or when nothing was recording.
 */
export function stopRecording(
  discard: boolean
): Promise<RecorderResult | null> {
  return invoke<RecorderResult | null, { discard: boolean }>(
    "stop_recording",
    { discard }
  );
}

/**
 * Audio endpoints for the settings UI. `system: true` lists render
 * endpoints (captured in loopback); otherwise microphones. An empty
 * list is a valid answer — a machine with no microphone is a
 * configuration, not an error.
 */
export function listAudioDevices(
  system: boolean
): Promise<AudioDeviceInfo[]> {
  return invoke<AudioDeviceInfo[], { system: boolean }>(
    "list_audio_devices",
    { system }
  );
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

/** Roughly twice a second while a session runs. Drives the HUD's timer,
 *  frame count, dropped count and size readout. */
export function onRecorderTick(cb: (e: RecorderStatus) => void): () => void {
  return on<RecorderStatus>(EVENT_NAMES.recorderTick, cb);
}

/** Fires once when a session ends, whatever the reason — including a
 *  duration limit the worker hit on its own, which no caller asked for
 *  and which the HUD must still react to. */
export function onRecorderFinished(
  cb: (e: RecorderFinished) => void
): () => void {
  return on<RecorderFinished>(EVENT_NAMES.recorderFinished, cb);
}
