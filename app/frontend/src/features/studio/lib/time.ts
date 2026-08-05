/**
 * Timeline arithmetic — milliseconds, frames and the strings a human
 * reads them as.
 *
 * Milliseconds are the unit everything else in Studio speaks, because
 * they are what the platform gives us: `HTMLMediaElement.currentTime` is
 * seconds as a float, and the backend's `MediaInfo` is milliseconds.
 * Frames are a *view* of that, derived when the UI needs a grid to snap
 * to. Storing frames instead would mean re-deriving the real position on
 * every seek and accumulating rounding error along the timeline.
 */

/** Milliseconds in one frame at `fps`. */
export function frameDurationMs(fps: number): number {
  // `fps` arrives from `MediaInfo`, which the backend guarantees is
  // never zero — but a guard here costs nothing and the alternative is
  // an `Infinity` that propagates silently into every seek.
  return fps > 0 ? 1000 / fps : 1000 / 30;
}

/** Which frame a position falls in. Floors: a position is *inside* the
 *  frame that is currently on screen, not the next one. */
export function msToFrame(ms: number, fps: number): number {
  return Math.floor(ms / frameDurationMs(fps));
}

/** Where a frame starts. */
export function frameToMs(frame: number, fps: number): number {
  return frame * frameDurationMs(fps);
}

/**
 * Move `ms` by `delta` whole frames, staying inside `[0, durationMs]`.
 *
 * Snaps to the frame grid before stepping. Without that, stepping
 * forward from an arbitrary scrub position lands mid-frame and the
 * picture doesn't change — the classic "my frame-step button does
 * nothing every other press" bug, which is really "the seek landed
 * inside the frame that was already showing".
 */
export function stepFrame(
  ms: number,
  fps: number,
  delta: number,
  durationMs: number
): number {
  const target = frameToMs(msToFrame(ms, fps) + delta, fps);
  return clampMs(target, durationMs);
}

/** Hold a position inside the clip. */
export function clampMs(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(ms, 0), Math.max(durationMs, 0));
}

/**
 * A position as a human reads it: `M:SS.cc`, growing an hours field
 * only when the clip needs one.
 *
 * Centiseconds rather than frames, because the readout sits beside a
 * scrubber the user drags with a mouse — two decimal places is the
 * precision that motion actually has. The frame number is available
 * separately, for the places (frame stepping, trim handles) where the
 * grid is what matters.
 *
 * Always shows two digits of seconds so the string stops jittering in
 * width as it counts, which is what makes it usable as a live readout.
 */
export function formatTimecode(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const centis = Math.floor((safe % 1000) / 10);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  const pad = (n: number) => String(n).padStart(2, "0");
  const stem = hours > 0 ? `${hours}:${pad(minutes)}` : `${minutes}`;
  return `${stem}:${pad(seconds)}.${pad(centis)}`;
}

/**
 * A duration as a human reads it: `1m 20s`, `4.5s`, `320ms`.
 *
 * Distinct from {@link formatTimecode} on purpose. A timecode answers
 * "where am I", and its fixed width is the point. A duration answers
 * "how much", where a fixed width is noise — "0:04.50" makes the reader
 * do arithmetic to learn that a trim is four and a half seconds long.
 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (safe < 1000) return `${Math.round(safe)}ms`;
  const seconds = safe / 1000;
  if (seconds < 60) {
    // Drop a trailing `.0` — "5s" reads better than "5.0s".
    const rounded = Math.round(seconds * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  // 59.6s rounds to 60, which must read as the next minute rather than
  // as "1m 60s".
  if (rest === 60) return `${minutes + 1}m`;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/**
 * Position along a track, as a `0..1` fraction.
 *
 * The one conversion the timeline's pointer handling and its rendering
 * both go through, so a playhead can never be drawn somewhere a click
 * wouldn't seek to.
 */
export function msToFraction(ms: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(Math.max(ms / durationMs, 0), 1);
}

/** The inverse — a fraction of the track back to a position. */
export function fractionToMs(fraction: number, durationMs: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return clampMs(fraction * durationMs, durationMs);
}
