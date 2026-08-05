/**
 * Presets IPC client + the `runPreset` orchestrator.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live here. A preset is a saved `CaptureRequest` plus
 * output steps; `runPreset` dispatches it through the existing capture /
 * overlay clients and handles the post-capture "open editor" step — so both
 * the tray and the dashboard manager run a preset the same way. See
 * [ADR 0004](../../../../docs/decisions/0004-capture-presets.md). The
 * wire-format types live in `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::preset::*` + `services::presets_service::*`.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import type {
  CapturePreset,
  PresetInput,
  RecorderRequest,
} from "@clippity/shared";
import { isRecordingPreset } from "@clippity/shared";

import { captureFullscreen } from "./capture";
import { emitErrorToast } from "./toast";
import { beginRegionCapture, emitOverlayToggles } from "./overlay";
import {
  emitOverlayRecordFormat,
  emitOverlayRecordPreset,
  startRecording,
} from "./recorder";

// ---------- Wire-format types (mirror Rust `domain::preset`) ----------
export type {
  PresetOutput,
  CapturePreset,
  PresetInput,
  PresetRequest,
} from "@clippity/shared";
export { isRecordingPreset, presetTarget } from "@clippity/shared";

// ---------- IPC wrappers ----------

export function presetsList(): Promise<CapturePreset[]> {
  return invoke<CapturePreset[]>("presets_list");
}

export function presetsCreate(input: PresetInput): Promise<CapturePreset> {
  return invoke<CapturePreset, { input: PresetInput }>("presets_create", {
    input,
  });
}

export function presetsUpdate(preset: CapturePreset): Promise<CapturePreset> {
  return invoke<CapturePreset, { preset: CapturePreset }>("presets_update", {
    preset,
  });
}

export function presetsDelete(id: string): Promise<void> {
  return invoke<void, { id: string }>("presets_delete", { id });
}

/**
 * Subscribe to `clippity://presets/changed`. The backend emits the full
 * `CapturePreset[]` after any create / update / delete. Returns a sync
 * unsubscribe — return it directly from a `useEffect`.
 */
export function onPresetsChanged(
  handler: (presets: CapturePreset[]) => void
): () => void {
  return on<CapturePreset[]>(EVENT_NAMES.presetsChanged, handler);
}

// ---------- Run orchestration ----------

/**
 * Run a preset: dispatch its capture (reusing the capture / overlay
 * clients). `output.openEditor` is the preset's editor intent — it's
 * folded into the capture's `preview` flag so the backend stamps it onto
 * `capture/finished` and the main window's persistent listener
 * ({@link useOpenEditorOnPreview}) opens the editor, the same path
 * interactive captures use. Save-dir flows through the request
 * (`outputDir`) for fullscreen and through `beginRegionCapture`'s
 * argument for region/window; the preset's toggles are seeded into the
 * overlay so its finalize reports them back. Errors surface as an error
 * toast (matching `useCaptureWorkflow`); the caller never needs a
 * try/catch.
 *
 * The preset's **name** rides the same two routes, and is the reason
 * they exist as parameters at all: it is the one thing the capture's
 * provenance record can't be written without being told, since the
 * backend only ever sees an ordinary capture command. Stamped here at
 * dispatch rather than stored on `preset.request`, so a renamed preset
 * records its new name rather than whatever it was called when saved.
 *
 * No delay branch in v1 (a "timed preset" is a deferred non-goal — see
 * ADR 0004).
 */
export async function runPreset(preset: CapturePreset): Promise<void> {
  if (isRecordingPreset(preset.request)) {
    await runRecordingPreset(preset, preset.request);
    return;
  }
  const request = preset.request;

  // Either the explicit preview toggle or the preset's openEditor output
  // means "open the editor afterwards" — collapse them into one flag.
  const preview = request.toggles.preview || preset.output.openEditor;

  try {
    const saveDir = preset.output.saveDir;
    switch (request.type) {
      case "fullscreen":
        await captureFullscreen({
          ...request,
          toggles: { ...request.toggles, preview },
          outputDir: saveDir,
          preset: preset.name,
        });
        break;
      case "region":
      case "window":
        // Seed the overlay with the preset's toggles (preview folded in)
        // before it opens; the overlay reports them back at finalize.
        await emitOverlayToggles({
          preview,
          clipboard: request.toggles.clipboard,
          cursor: request.toggles.cursor,
          enhance: request.toggles.enhance,
        });
        await beginRegionCapture(request.type, saveDir, preset.name);
        break;
      default:
        // `custom` isn't a valid preset target in v1 — nothing emits
        // `capture/finished`, so there's nothing to open.
        break;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Preset failed to run.";
    void emitErrorToast(message);
  }
}

/**
 * Run a recording preset — Clippity's answer to switching OBS scenes.
 *
 * Fullscreen starts immediately. Region and Window go through the
 * overlay first, and **the whole request is mirrored across**, not just
 * the format: the overlay is a separate window whose finalize otherwise
 * rebuilds the request from live settings, which would silently discard
 * the preset's frame rate, resolution, audio levels and encoder
 * settings. See `emitOverlayRecordPreset`.
 *
 * `output.openEditor` is ignored here rather than folded into a preview
 * flag: the editor cannot open a video (ADR 0031), so honouring it would
 * promise something nothing keeps. The preset editor hides the control
 * for a recording preset for the same reason.
 */
async function runRecordingPreset(
  preset: CapturePreset,
  request: RecorderRequest
): Promise<void> {
  // Stamped at dispatch, not stored, so a renamed preset records its new
  // name — exactly as the capture path does.
  const stamped: RecorderRequest = {
    ...request,
    outputDir: preset.output.saveDir,
    preset: preset.name,
  };

  try {
    if (request.target === "fullscreen") {
      await startRecording(stamped);
      return;
    }
    // The format mirror still goes out: the overlay's chrome reads it
    // for its own labelling, independently of the request override.
    await emitOverlayRecordFormat(request.format);
    await emitOverlayRecordPreset(stamped);
    await beginRegionCapture(
      request.target === "window" ? "record-window" : "record-region"
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Preset failed to run.";
    void emitErrorToast(message);
  }
}
