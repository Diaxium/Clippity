/**
 * Trim-range rules — what the in/out handles are allowed to do.
 *
 * The backend validates a trim before encoding it, and this does *not*
 * duplicate that check. The two answer different questions. The backend
 * asks "is this range encodable", once, and refuses if not. This asks
 * "where does the handle go while the pointer is here", sixty times a
 * second, and must always have an answer — a drag that could produce an
 * invalid range has to be *prevented*, not reported, because there is
 * nothing to report to mid-gesture.
 *
 * So every function here resolves rather than rejects.
 */

import { clampMs } from "./time";

/** Which end of the range a gesture is moving. */
export type TrimHandle = "in" | "out";

export interface TrimRange {
  startMs: number;
  endMs: number;
}

/**
 * Shortest range the handles can be dragged to.
 *
 * Matches `domain::media::MIN_TRIM_MS`, and is duplicated rather than
 * imported because it means something different on each side: there it
 * is a *refusal* — a range below it cannot be encoded. Here it is a
 * *stop* the handle rests against, so the gesture simply cannot reach
 * the state the backend would refuse. Keeping them equal is what makes
 * the export button never disabled for a reason the timeline didn't
 * show.
 */
export const MIN_TRIM_MS = 200;

/** The whole clip, which is what an untrimmed range is. */
export function fullRange(durationMs: number): TrimRange {
  return { startMs: 0, endMs: durationMs };
}

/**
 * Where a dragged handle lands.
 *
 * The opposite handle never moves. A drag that would cross it stops
 * [`MIN_TRIM_MS`] short instead — pushing the other handle along would
 * mean a single gesture silently redefining the end the user had already
 * placed, which is the more surprising of the two behaviours.
 */
export function resolveHandleDrag(
  range: TrimRange,
  handle: TrimHandle,
  ms: number,
  durationMs: number
): TrimRange {
  const position = clampMs(ms, durationMs);
  if (handle === "in") {
    // Leave room for the minimum, but never propose a start beyond the
    // clip itself on a very short recording.
    const ceiling = Math.max(range.endMs - MIN_TRIM_MS, 0);
    return { ...range, startMs: Math.min(position, ceiling) };
  }
  const floor = Math.min(range.startMs + MIN_TRIM_MS, durationMs);
  return { ...range, endMs: Math.max(position, floor) };
}

/**
 * Slide the whole range without changing its length, keeping it inside
 * the clip.
 *
 * Dragging the selected band is how a user says "same length, different
 * moment" — the alternative is moving both handles and getting the
 * duration wrong in between.
 */
export function moveRange(
  range: TrimRange,
  deltaMs: number,
  durationMs: number
): TrimRange {
  const length = range.endMs - range.startMs;
  // Clamp the *start* against the room the range needs, so a drag that
  // runs off either end parks flush instead of being squashed shorter.
  const startMs = clampMs(
    range.startMs + deltaMs,
    Math.max(durationMs - length, 0)
  );
  return { startMs, endMs: startMs + length };
}

/** Whether anything has actually been cut. Drives whether the export
 *  reads "Export clip" or "Export trimmed clip", and whether a reset
 *  control is worth showing at all. */
export function isTrimmed(range: TrimRange, durationMs: number): boolean {
  return range.startMs > 0 || range.endMs < durationMs;
}

/** Length of the exported clip. */
export function rangeDurationMs(range: TrimRange): number {
  return Math.max(range.endMs - range.startMs, 0);
}

/**
 * Keep the playhead inside the trimmed range during playback.
 *
 * Returns the position to seek to, or `null` when the playhead is
 * already where it belongs. Playing a trim should preview *the trim* —
 * running past the out-point shows footage the export won't contain,
 * which makes the handles feel decorative.
 */
export function nextPlayheadWithinRange(
  ms: number,
  range: TrimRange
): number | null {
  if (ms < range.startMs) return range.startMs;
  // Only pull back to the in-point at the out-point, so the transport
  // loops the selection rather than stopping dead at its end.
  if (ms >= range.endMs) return range.startMs;
  return null;
}

/**
 * Snap a position to the nearest trim edge when it is within `toleranceMs`.
 *
 * A scrubber drag is a coarse instrument, and the two positions a user
 * most wants to land on exactly are the ones they just placed. Snapping
 * only to those two — not to a grid — keeps the rest of the timeline
 * free.
 */
export function snapToEdges(
  ms: number,
  range: TrimRange,
  toleranceMs: number
): number {
  const edges = [range.startMs, range.endMs];
  let best = ms;
  let bestDistance = toleranceMs;
  for (const edge of edges) {
    const distance = Math.abs(edge - ms);
    if (distance <= bestDistance) {
      best = edge;
      bestDistance = distance;
    }
  }
  return best;
}
