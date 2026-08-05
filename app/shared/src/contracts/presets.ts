/**
 * Presets wire-format contracts — mirror Rust `domain::preset`.
 *
 * A preset is a saved `CaptureRequest` **or** `RecorderRequest`, plus
 * output steps. Recordings are presets rather than a separate "scenes"
 * concept: this codebase already had saved, named, switchable capture
 * configurations, and a second surface for the same idea would mean two
 * managers and two run paths.
 */

import type { CaptureRequest } from "./capture";
import type { RecorderRequest } from "./recorder";

export interface PresetOutput {
  /** Open the new capture in the editor once it finishes. Meaningless
   *  for a recording preset — the editor can't open a video — so the
   *  editor hides it there rather than offering a promise nothing
   *  keeps. */
  openEditor: boolean;
  /** Save-directory override; null = the live captures dir. */
  saveDir: string | null;
}

/**
 * What a preset does when it runs.
 *
 * Untagged on the wire, because presets already on disk are bare
 * `CaptureRequest` objects with no discriminant. Safe because the two
 * shapes are disjoint by *required* field — a capture must carry `type`
 * and `toggles`, a recording must carry `target` and `format` — which is
 * exactly what {@link isRecordingPreset} tests.
 */
export type PresetRequest = CaptureRequest | RecorderRequest;

/**
 * Narrow a preset's request to a recording.
 *
 * Checks the field a `RecorderRequest` cannot omit rather than the
 * absence of a capture field: "has a format" is a positive statement
 * about what this *is*, and stays correct if `CaptureRequest` ever gains
 * an optional field with a colliding name.
 */
export function isRecordingPreset(
  request: PresetRequest,
): request is RecorderRequest {
  return "format" in request && "target" in request;
}

/**
 * The surface a preset acts on — `fullscreen` / `region` / `window` for
 * either kind, since a recording's `target` and a capture's `type` are
 * the same three answers under different field names.
 *
 * Exists because three separate surfaces (the presets grid, the tray
 * list, the Home launcher) each need an icon and a label for a preset,
 * and each one reaching into the union itself is three chances to forget
 * the recording case.
 */
export function presetTarget(request: PresetRequest): string {
  return isRecordingPreset(request) ? request.target : request.type;
}

export interface CapturePreset {
  id: string;
  name: string;
  request: PresetRequest;
  output: PresetOutput;
}

/** Create payload — everything but the id, which the backend mints. */
export interface PresetInput {
  name: string;
  request: PresetRequest;
  output: PresetOutput;
}
