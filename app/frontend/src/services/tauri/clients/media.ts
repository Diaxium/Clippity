/**
 * Studio media IPC client + cross-window open helper.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so cross-feature
 * consumers (the library's "Edit video" action, the recorder toast's
 * future hand-off) all import from one place. The wire-format types live
 * in `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::media::*` + `services::media_service::*`.
 *
 * The counterpart to `editor.ts`, and the interesting difference is
 * what is *absent*: there is no `mediaLoad` returning bytes. See
 * {@link mediaUrl}.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import { convertFileSrc } from "@tauri-apps/api/core";
import type {
  MediaInfo,
  MediaToken,
  TrimProgress,
  TrimRequest,
  TrimResult,
} from "@clippity/shared";

import { openDashboard } from "./dashboard";

// ---------- Wire-format types (mirror Rust `domain::media`) ----------
export type {
  MediaInfo,
  MediaToken,
  TrimRequest,
  TrimProgress,
  TrimResult,
} from "@clippity/shared";

// ---------- IPC wrappers ----------

/**
 * Describe the recording at `id` and mint the token its bytes are
 * fetchable under. Rejects ids outside the captures directory, and
 * anything that isn't a video.
 *
 * Cheap regardless of the clip's length — the backend reads the
 * container's headers and stops, so a two-hour recording opens as fast
 * as a two-second one.
 */
export function mediaProbe(id: string): Promise<MediaInfo> {
  return invoke<MediaInfo, { id: string }>("media_probe", { id });
}

/**
 * Encode the requested range as a new capture and resolve with what was
 * written.
 *
 * Slow by nature — the backend decodes and re-encodes rather than
 * remuxing, so a cut lands on the exact frame the handles showed instead
 * of snapping to the nearest keyframe. Pair with {@link onTrimProgress}.
 *
 * Never overwrites the source: a trim is always a new file.
 */
export function mediaTrim(request: TrimRequest): Promise<TrimResult> {
  return invoke<TrimResult, { request: TrimRequest }>("media_trim", {
    request,
  });
}

/**
 * Stage one rendered annotation overlay and resolve with its path, for
 * naming in a {@link TrimRequest}.
 *
 * Called once per interval between annotation boundaries — never per
 * frame. Staged as a file rather than sent inline with the trim for the
 * same reason the clip itself is never sent over IPC: a payload is
 * serialised whole, and a handful of full-resolution bitmaps is
 * megabytes.
 *
 * The backend chooses the path and verifies the bytes really are a PNG;
 * this side supplies only base64. Staged files are cleaned up by the
 * export that consumes them, however it ends.
 */
export function mediaStageOverlay(pngBase64: string): Promise<string> {
  return invoke<string, { pngBase64: string }>("media_stage_overlay", {
    pngBase64,
  });
}

/**
 * Ask the running export to stop. Idempotent, and a no-op when nothing
 * is running. The export unwinds at a frame boundary and deletes its
 * partial file, so cancelling leaves nothing in the library.
 */
export function mediaCancelTrim(): Promise<void> {
  return invoke<void>("media_cancel_trim");
}

/** Subscribe to export progress. Returns a sync unsubscribe. */
export function onTrimProgress(
  handler: (progress: TrimProgress) => void
): () => void {
  return on<TrimProgress>(EVENT_NAMES.mediaTrimProgress, handler);
}

// ---------- Playback ----------

/**
 * URI scheme a recording is streamed over. Must match `MEDIA_SCHEME` in
 * the backend's `lib.rs`.
 */
const MEDIA_SCHEME = "clippity-media";

/**
 * Where the player loads a clip's bytes from.
 *
 * A token plus a URL rather than the media itself, and for a stronger
 * reason than the snapshot scheme's: a recording is not merely large,
 * it is *seeked*. A `<video>` element asks for the byte ranges around
 * the playhead and asks for different ones when the user scrubs — so
 * the bytes cannot travel through the IPC bridge at all, no matter how
 * patient we are about the size. The backend answers ranged requests
 * with `206 Partial Content`; see `media_scheme.rs`.
 *
 * The token is in the path, so each opened clip has a distinct URL and
 * a stale one can never resolve to a different recording.
 */
export function mediaUrl(token: MediaToken): string {
  return convertFileSrc(String(token), MEDIA_SCHEME);
}

// ---------- Cross-window helper ----------

/**
 * Bring the dashboard window forward and switch it to Studio with `id`
 * loaded. Used by the library's "Edit video" action. Routes through
 * `openDashboard` so it shares the race-free stash-then-show pattern
 * with every other cross-window jump.
 */
export async function openInStudio(id: string): Promise<void> {
  await openDashboard("studio", id);
}
