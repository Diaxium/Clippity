/**
 * Precision-pointer damping — the "hold Alt to slow the cursor" system.
 *
 * The overlay draws its own crosshair (`cursor: none` on the root), so the
 * point the user *sees* need not be the point the OS reports. That gap is
 * what makes micro-adjustment possible: while the precision modifier is
 * held, raw pointer travel is scaled down by `PRECISION_FACTOR`, so a
 * 5 px flick of the hand moves the reticle a single pixel.
 *
 * The divergence is carried as an `offset` (virtual − raw) rather than an
 * anchor point, which is what keeps the modifier press *and* release
 * jump-free: at both boundaries the virtual point is simply
 * `raw + offset`, and only the rate at which `offset` changes differs.
 *
 * Because the OS pointer travels ~1/`PRECISION_FACTOR` times farther
 * than the reticle, precision movement pushes the real cursor toward the
 * screen edges fast. Once it is pinned against one, pushing further that
 * way produces NO pointer events at all — so anything that only corrects
 * the offset *on movement* can never recover. Four things keep that from
 * stranding the reticle:
 *
 *   - Re-sync: releasing the modifier outside an interaction, or ending
 *     a drag, zeroes the offset outright (`sync`). Nothing is mid-flight
 *     that a jump could damage, so the honest thing is to put the
 *     reticle back on the real cursor.
 *   - Reel-in: while an interaction IS in flight, a jump would drag the
 *     selection edge with it, so the offset is instead pulled toward
 *     zero proportionally to travel — a fast swipe resolves it, careful
 *     movement barely touches it, and it never reads as a jump.
 *   - `MAX_OFFSET`: a hard cap on the divergence, so a long
 *     modifier-held drag can't strand the cursor at an edge before
 *     either of the above gets a chance to run.
 *   - Clamping: the virtual point is clamped to the viewport and the
 *     offset re-derived from the clamped result, so it can never exceed
 *     what the screen can express.
 *
 * Coordinates are logical px (CSS px), matching `geometry.ts`.
 */

import type { Pt } from "./types";

/** Fraction of raw pointer travel applied while the precision modifier is
 *  held. 0.16 → ~6 px of hand movement per on-screen pixel: slow enough
 *  to land a specific pixel, fast enough to cross a small icon. */
export const PRECISION_FACTOR = 0.16;

/** Share of each move's travel used to reel the offset back toward zero
 *  once the modifier is released mid-interaction. */
const REEL_IN_RATE = 0.3;

/** Hard cap (logical px) on how far the reticle may diverge from the OS
 *  pointer. Past this the reticle tracks the hand 1:1 again — a
 *  deliberate behaviour cliff, and the better trade: unbounded
 *  divergence drives the real cursor into a screen edge, where it stops
 *  producing pointer events and the reticle cannot be moved that way at
 *  all. 160 px allows ~190 px of damped hand travel per direction (~30 px
 *  of on-screen movement), far more than pixel-level positioning needs. */
const MAX_OFFSET = 160;

/** Clamp `v` into `[-MAX_OFFSET, MAX_OFFSET]`. */
function capped(v: number): number {
  return Math.min(Math.max(v, -MAX_OFFSET), MAX_OFFSET);
}

/** Live divergence between the drawn (virtual) point and the OS pointer. */
let offset: Pt = { x: 0, y: 0 };
/** Previous raw pointer position — the base for the per-move delta. */
let lastRaw: Pt | null = null;
/** Modifier state at the previous pointer event, so the true→false edge
 *  can be detected from the pointer stream itself. */
let wasPrecision = false;

/** Per-native-event memo. A single pointer move can reach the transform
 *  twice (the selection's own `onPointerMove` does not stop propagation,
 *  so the canvas-wide handler sees the same event as it bubbles). Without
 *  this the delta would be applied twice and the damping would come out
 *  at `FACTOR²`. Keyed on the native event, which is stable per real
 *  pointer event; entries die with the event object. */
const perEvent = new WeakMap<object, Pt>();

/** Shrink `v` toward zero by `pull`, never past it. */
function reelIn(v: number, pull: number): number {
  const next = Math.abs(v) - pull;
  return next <= 0 ? 0 : Math.sign(v) * next;
}

/**
 * Advance the virtual/raw divergence by one pointer move. Pure — exported
 * for the unit tests; call `precisionPoint` from interaction code.
 *
 * While `precision` is held the virtual point advances by only
 * `PRECISION_FACTOR` of the raw delta, which means the offset absorbs the
 * remaining `1 − FACTOR`. Otherwise the offset is reeled back toward zero.
 */
export function advanceOffset(
  current: Pt,
  from: Pt | null,
  to: Pt,
  precision: boolean
): Pt {
  if (!from) return current;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (precision) {
    const damp = 1 - PRECISION_FACTOR;
    return {
      x: capped(current.x - dx * damp),
      y: capped(current.y - dy * damp),
    };
  }
  const pull = Math.hypot(dx, dy) * REEL_IN_RATE;
  return { x: reelIn(current.x, pull), y: reelIn(current.y, pull) };
}

/**
 * Map a raw pointer position to the point the overlay should act on.
 *
 * `key` is the native event — pass `e.nativeEvent` so a single physical
 * move that reaches two handlers is only integrated once. Every pointer
 * event in a damped mode should go through here (down included), so the
 * delta chain has no gaps.
 *
 * `precision` MUST come from the pointer event's own `altKey`, not from
 * a flag maintained by keydown/keyup. On Windows a lone Alt press
 * activates the system menu and the webview never receives the keyup, so
 * a key-derived flag latches on and the release is never observed. Every
 * pointer event carries the live modifier state, and this function only
 * ever runs on pointer events — reading it here makes the release
 * impossible to miss.
 *
 * `canResync` is the caller's answer to "is it safe to snap the reticle
 * back onto the cursor right now?" — false while a drag is in flight,
 * where a jump would take the selection edge with it.
 */
export function precisionPoint(
  key: object | null | undefined,
  raw: Pt,
  precision: boolean,
  vw: number,
  vh: number,
  canResync = true
): Pt {
  const memo = key ? perEvent.get(key) : undefined;
  if (memo) return memo;

  // Release edge, observed on the pointer stream rather than trusted
  // from a key event. Snapping here (before the delta is applied) means
  // this very event already lands on the true cursor.
  const releasing = wasPrecision && !precision;
  wasPrecision = precision;
  if (releasing && canResync) offset = { x: 0, y: 0 };

  offset = advanceOffset(offset, lastRaw, raw, precision);
  lastRaw = raw;

  const p = {
    x: Math.min(Math.max(raw.x + offset.x, 0), vw),
    y: Math.min(Math.max(raw.y + offset.y, 0), vh),
  };
  // Re-derive from the clamped point so the offset can never bank travel
  // the viewport already refused — otherwise pushing into an edge under
  // precision would build up a debt the user has to unwind on the way out.
  offset = { x: p.x - raw.x, y: p.y - raw.y };

  if (key) perEvent.set(key, p);
  return p;
}

/**
 * Put the reticle back on the real cursor immediately, discarding any
 * accumulated divergence. Returns the OS pointer position it snapped to
 * so the caller can paint the crosshair there at once (otherwise the
 * correction wouldn't be visible until the next pointer move, which
 * reads as a lurch rather than as releasing the key).
 *
 * Safe only when nothing is mid-flight — during a drag this would take
 * the selection edge with it. Callers gate on that.
 */
export function syncPrecisionPointer(): Pt | null {
  offset = { x: 0, y: 0 };
  wasPrecision = false;
  return lastRaw;
}

/** Drop the accumulated divergence AND the delta chain. Called from the
 *  store's `reset` so a fresh overlay session starts clean — unlike
 *  `syncPrecisionPointer`, the next move after this seeds a new chain
 *  rather than continuing the old one. */
export function resetPrecisionPointer(): void {
  offset = { x: 0, y: 0 };
  lastRaw = null;
  wasPrecision = false;
}

/** Current divergence (virtual − raw), for tests + the precision readout. */
export function precisionOffset(): Pt {
  return offset;
}
