/**
 * Build a `RecorderRequest` from a target, a format, and the persisted
 * recording preferences (ADR 0031).
 *
 * Lives in `shared/` because two features start recordings and neither
 * may reach into the other: the Home launcher cards (`features/home`)
 * and the capture window's Record screen (`features/capture`). Promoted
 * here on the second consumer, not the first.
 *
 * Centralising it is what keeps the two entry points honest with each
 * other — a recording started from the launcher and one started from
 * the Record screen have to resolve audio, frame rate and cursor the
 * same way, or the same settings would mean different things depending
 * on which button the user pressed.
 */

import type {
  RecorderFormat,
  RecorderRequest,
  RecorderTarget,
} from "@services/tauri/clients/recorder";
import type { Region } from "@services/tauri/clients/overlay";
import type { RecordingSettings } from "@services/tauri/clients/settings";

/**
 * @param region Physical-pixel rect for a `region` / `window` target —
 *   the overlay resolves it, so the launcher's fullscreen path omits it
 *   and the backend picks the monitor under the cursor instead.
 */
/**
 * The request an overlay-started recording should use: a mirrored
 * preset's, with the rectangle the user just drew filled in — or a fresh
 * one built from live settings when no preset opened the overlay.
 *
 * Both overlay finalize paths (region drag, window click) go through
 * here for the same reason everything else goes through
 * {@link buildRecorderRequest}: a preset that applied on one and not the
 * other would be a bug nobody would think to look for.
 *
 * The override's own `format` and `target` win over the mirrored ones.
 * They cannot disagree in practice — the preset runner emits both — but
 * the preset is the authority on what it is, and deriving the answer
 * from one source instead of two removes the question.
 */
export function overlayRecorderRequest(
  target: RecorderTarget,
  format: RecorderFormat,
  settings: RecordingSettings | undefined,
  override: RecorderRequest | null,
  region: Region
): RecorderRequest {
  if (override) return { ...override, region };
  return buildRecorderRequest(target, format, settings, region);
}

export function buildRecorderRequest(
  target: RecorderTarget,
  format: RecorderFormat,
  settings: RecordingSettings | undefined,
  region?: Region
): RecorderRequest {
  // Settings are undefined until the store hydrates. Falling back to a
  // bare request rather than refusing means an early hotkey still
  // records — silently, at the backend's defaults — which beats doing
  // nothing to a moment the user wanted captured.
  if (!settings) return { target, format, region };

  const gif = format === "gif";
  return {
    target,
    format,
    region,
    // The two rates are stored separately because their legal ranges
    // differ; carrying one across a format switch would land outside
    // the other's envelope.
    fps: gif ? settings.gifFps : settings.videoFps,
    // One value for both formats, unlike the rates: GIF's own pixel
    // budget is tighter than any offered height, so the two bounds
    // compose instead of conflicting.
    maxHeight: settings.maxHeight,
    // Sent for GIF too, and ignored there. Unlike the audio selection,
    // which is emptied so the HUD can't show a microphone indicator for
    // a track nobody is writing, encoder settings have no indicator to
    // mislead — and clearing them would lose the user's choice the
    // moment they switch format back.
    encoding: settings.encoding,
    // Sources apply to both formats: a GIF is still a picture of the
    // screen, and a webcam in the corner is as meaningful there.
    sources: settings.sources,
    audio: {
      // GIF carries no audio track. The backend empties the selection
      // anyway, but sending it would make the HUD show a microphone
      // indicator for a track nobody is recording.
      microphone: gif ? false : settings.microphone,
      system: gif ? false : settings.systemAudio,
      microphoneDevice: settings.microphoneDevice ?? null,
      systemDevice: settings.systemDevice ?? null,
      // The level each input *starts* at. The HUD's sliders take over
      // from here for the rest of the session.
      microphoneGainPct: settings.microphoneGainPct,
      systemGainPct: settings.systemGainPct,
    },
    toggles: {
      cursor: settings.cursor,
      clicks: false,
      // The editor cannot open a video, so a finished recording is
      // never handed to it — see ADR 0031.
      preview: false,
      clipboard: settings.clipboard,
    },
  };
}
