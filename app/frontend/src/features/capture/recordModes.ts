/**
 * Recording-mode taxonomy + pure helpers (ADR 0031).
 *
 * The recorder's counterpart to `modes.ts`. Same shape — `ModeDef`
 * tiles, an `AVAILABLE_*` set, a per-mode option filter — so the Record
 * screen reads like the Capture screen and the two can share
 * `ModeTile`.
 *
 * Kept separate rather than folded into `modes.ts` because the two
 * taxonomies answer different questions: a capture picks a *shape*
 * (region, window, custom sub-mode), a recording picks a **target and
 * an output format**, and their option sets barely overlap. Same
 * reasoning that keeps `domain::recorder` out of `domain::capture`.
 *
 * No React, no Zustand, no IPC. Unit-testable in isolation.
 */

import { AppWindow, Crop, Film, Maximize, Repeat } from "lucide-react";

import type { OverlayMode } from "@services/tauri/clients/overlay";
import type {
  RecorderFormat,
  RecorderTarget,
} from "@services/tauri/clients/recorder";

import type { ModeDef } from "./types";

/**
 * What surface to record — the top row of tiles.
 *
 * Fullscreen starts immediately on the monitor under the cursor. Region
 * and Window go through the overlay first, which picks the rectangle
 * and then starts the session (see `OVERLAY_MODE_FOR_TARGET`).
 */
export const RECORD_TARGETS: readonly ModeDef<RecorderTarget>[] = [
  {
    id: "fullscreen",
    label: "Fullscreen",
    desc: "Record the whole display the cursor is on.",
    icon: Maximize,
    tint: "warm",
    available: true,
  },
  {
    id: "region",
    label: "Region",
    desc: "Record a rectangle you draw on screen.",
    icon: Crop,
    tint: "cool",
    available: true,
  },
  {
    id: "window",
    label: "Window",
    desc: "Record a single window you pick.",
    icon: AppWindow,
    tint: "warm",
    available: true,
  },
];

/**
 * Which overlay mode a target opens, or `null` when it needs no
 * overlay.
 *
 * Fullscreen is the `null` case — there is nothing to select, so
 * bouncing through a selection surface would only add a step. The other
 * two need a rectangle before a session can start, which is exactly
 * what the overlay is for.
 */
export const OVERLAY_MODE_FOR_TARGET: Record<
  RecorderTarget,
  OverlayMode | null
> = {
  fullscreen: null,
  region: "record-region",
  window: "record-window",
};

/**
 * The output the session encodes to.
 *
 * A first-class choice rather than a toggle in the options panel: it
 * changes the usable frame-rate range, whether audio means anything,
 * and how long a session may run. One capture session feeds whichever
 * encoder this picks (ADR 0031).
 */
export const RECORD_FORMATS: readonly ModeDef<RecorderFormat>[] = [
  {
    id: "mp4",
    label: "Video",
    desc: "H.264 MP4 with optional audio. Best for anything longer than a moment.",
    icon: Film,
    tint: "warm",
    available: true,
  },
  {
    id: "gif",
    label: "GIF",
    desc: "A silent, looping clip. Capped at a minute — ideal for a short demo.",
    icon: Repeat,
    tint: "cool",
    available: true,
  },
];

/** Targets armable in the current build. */
export const AVAILABLE_RECORD_TARGETS: ReadonlySet<RecorderTarget> = new Set(
  RECORD_TARGETS.filter((t) => t.available).map((t) => t.id)
);

/** Formats armable in the current build. */
export const AVAILABLE_RECORD_FORMATS: ReadonlySet<RecorderFormat> = new Set(
  RECORD_FORMATS.filter((f) => f.available).map((f) => f.id)
);

/**
 * Which option rows the Record options panel should render.
 *
 * GIF drops both audio rows — the format has no audio track, and the
 * backend empties the selection anyway, so showing the toggles would
 * offer a promise nothing keeps. Mirrors `visibleOptionKeys`, which
 * hides the same kind of dead control per capture mode.
 */
export function visibleRecordOptionKeys(
  format: RecorderFormat
): ReadonlySet<string> {
  if (format === "gif") {
    return new Set(["cursor", "outline", "clipboard", "fps"]);
  }
  return new Set([
    "microphone",
    "systemAudio",
    "cursor",
    "outline",
    "clipboard",
    "fps",
  ]);
}

/**
 * Whether the current selection can start a recording — the Record
 * button's enablement, and the reason when it can't.
 */
export function recordReadiness(
  target: RecorderTarget,
  format: RecorderFormat
): { ready: boolean; reason?: string } {
  if (!AVAILABLE_RECORD_TARGETS.has(target)) {
    return {
      ready: false,
      reason:
        RECORD_TARGETS.find((t) => t.id === target)?.unavailableHint ??
        "This recording target isn't available yet",
    };
  }
  if (!AVAILABLE_RECORD_FORMATS.has(format)) {
    return { ready: false, reason: "This output format isn't available yet" };
  }
  return { ready: true };
}
