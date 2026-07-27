/**
 * Presets wire-format contracts — mirror Rust `domain::preset`.
 *
 * A preset is a saved `CaptureRequest` plus output steps.
 */

import type { CaptureRequest } from "./capture";

export interface PresetOutput {
  /** Open the new capture in the editor once it finishes. */
  openEditor: boolean;
  /** Save-directory override; null = the live captures dir. */
  saveDir: string | null;
}

export interface CapturePreset {
  id: string;
  name: string;
  request: CaptureRequest;
  output: PresetOutput;
}

/** Create payload — everything but the id, which the backend mints. */
export interface PresetInput {
  name: string;
  request: CaptureRequest;
  output: PresetOutput;
}
