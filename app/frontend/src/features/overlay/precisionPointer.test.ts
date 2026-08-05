import { beforeEach, describe, expect, it } from "vitest";

import {
  PRECISION_FACTOR,
  advanceOffset,
  precisionOffset,
  precisionPoint,
  resetPrecisionPointer,
  syncPrecisionPointer,
} from "./precisionPointer";

const VW = 1920;
const VH = 1080;

/** Feed one pointer move through the stateful transform. Each call gets a
 *  fresh key so it counts as a distinct native event. */
function move(raw: { x: number; y: number }, precision: boolean) {
  return precisionPoint({}, raw, precision, VW, VH);
}

describe("advanceOffset", () => {
  it("is a no-op on the first sample (no previous point to delta from)", () => {
    const off = { x: 4, y: -2 };
    expect(advanceOffset(off, null, { x: 100, y: 100 }, true)).toBe(off);
  });

  it("absorbs the undamped share of travel while precision is held", () => {
    const next = advanceOffset(
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 110, y: 100 },
      true
    );
    // 10 px of hand travel, PRECISION_FACTOR of it reaches the screen.
    expect(next.x).toBeCloseTo(-10 * (1 - PRECISION_FACTOR));
    expect(next.y).toBe(0);
  });

  it("reels the offset back toward zero when precision is released", () => {
    const next = advanceOffset(
      { x: -20, y: 0 },
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      false
    );
    expect(Math.abs(next.x)).toBeLessThan(20);
    expect(next.x).toBeLessThanOrEqual(0); // never overshoots past zero
  });

  it("never reels past zero on a large move", () => {
    expect(
      advanceOffset({ x: -5, y: 3 }, { x: 0, y: 0 }, { x: 900, y: 0 }, false)
    ).toEqual({ x: 0, y: 0 });
  });
});

describe("precisionPoint", () => {
  beforeEach(resetPrecisionPointer);

  it("tracks the raw pointer 1:1 with the modifier up", () => {
    move({ x: 400, y: 400 }, false);
    expect(move({ x: 480, y: 430 }, false)).toEqual({ x: 480, y: 430 });
  });

  it("damps travel to PRECISION_FACTOR while the modifier is held", () => {
    move({ x: 400, y: 400 }, false);
    const p = move({ x: 500, y: 400 }, true);
    expect(p.x - 400).toBeCloseTo(100 * PRECISION_FACTOR);
  });

  it("does not jump when the modifier is pressed", () => {
    move({ x: 400, y: 400 }, false);
    const engaged = move({ x: 400, y: 400 }, true); // Alt down, no movement
    expect(engaged).toEqual({ x: 400, y: 400 });
  });

  it("returns to the OS cursor when the modifier is released while idle", () => {
    // This deliberately REPLACES an earlier "no jump on release"
    // assertion. Carrying the divergence past the release is exactly
    // what stranded the reticle: precision walks the OS cursor into a
    // screen edge, and past that point pushing further emits no pointer
    // events for any movement-driven correction to run on. Outside a
    // drag there is nothing a snap can damage, so the reticle belongs
    // back on the real cursor.
    move({ x: 400, y: 400 }, false);
    move({ x: 440, y: 400 }, true);
    expect(move({ x: 440, y: 400 }, false)).toEqual({ x: 440, y: 400 });
  });

  it("integrates a repeated native event only once", () => {
    move({ x: 400, y: 400 }, true);
    const key = {};
    const first = precisionPoint(key, { x: 500, y: 400 }, true, VW, VH);
    // Same event bubbling to a second handler — the selection's own
    // onPointerMove does not stopPropagation, so this really happens.
    const second = precisionPoint(key, { x: 500, y: 400 }, true, VW, VH);
    expect(second).toEqual(first);
  });

  it("resolves the divergence over subsequent free movement", () => {
    move({ x: 400, y: 400 }, false);
    move({ x: 600, y: 400 }, true); // build a large offset
    expect(Math.abs(precisionOffset().x)).toBeGreaterThan(50);

    for (let i = 1; i <= 12; i++) move({ x: 600 + i * 60, y: 400 }, false);
    expect(precisionOffset()).toEqual({ x: 0, y: 0 });
  });

  it("clamps to the viewport without banking refused travel", () => {
    move({ x: 10, y: 400 }, false);
    move({ x: 0, y: 400 }, false);
    // Push hard into the left edge: the OS cursor is pinned at 0, so the
    // virtual point cannot go negative and must not owe travel on the way
    // back out.
    const pinned = move({ x: 0, y: 400 }, true);
    expect(pinned.x).toBe(0);
    expect(precisionOffset().x).toBe(0);
  });

  // Regression: releasing Alt used to leave the whole accumulated
  // divergence in place. Because damped travel drives the OS pointer
  // ~1/FACTOR times farther than the reticle, the real cursor routinely
  // ended up pinned against a screen edge with the reticle still far
  // inland — and pushing further that way emits NO pointer events, so
  // the reel-in (which only runs on movement) could never recover. The
  // reticle was stuck until something else perturbed the state.
  it("sync puts the reticle back on the OS cursor", () => {
    move({ x: 400, y: 400 }, false);
    move({ x: 600, y: 400 }, true);
    expect(Math.abs(precisionOffset().x)).toBeGreaterThan(50);

    expect(syncPrecisionPointer()).toEqual({ x: 600, y: 400 });
    expect(precisionOffset()).toEqual({ x: 0, y: 0 });
    // And tracking is 1:1 from there, with no leftover debt.
    expect(move({ x: 640, y: 400 }, false)).toEqual({ x: 640, y: 400 });
  });

  // Regression #2. The first fix for the freeze hung off the window's
  // Alt `keyup`, which the browser preview always delivered and the
  // packaged Windows app did not: a lone Alt press activates the system
  // menu bar and the webview never sees the release. Recovery must
  // therefore be driven by the modifier flag carried on each pointer
  // event, which is live OS state and arrives on the same stream the
  // damping runs on. These tests never touch a key event at all.
  it("recovers from the pointer stream alone, with no keyup (regression)", () => {
    move({ x: 400, y: 400 }, false);
    move({ x: 600, y: 400 }, true); // Alt held: builds divergence
    expect(Math.abs(precisionOffset().x)).toBeGreaterThan(50);

    // Alt physically released, but NO keyup ever fires. The next pointer
    // event simply reports altKey === false.
    const first = move({ x: 640, y: 400 }, false);
    expect(first).toEqual({ x: 640, y: 400 });
    expect(precisionOffset()).toEqual({ x: 0, y: 0 });
  });

  it("holds the reticle steady mid-drag even without a keyup", () => {
    move({ x: 400, y: 400 }, false);
    const crept = move({ x: 500, y: 400 }, true);
    // canResync=false — a drag is in flight, so the release must NOT
    // snap; the offset reels in gradually instead.
    const released = precisionPoint(
      {},
      { x: 500, y: 400 },
      false,
      VW,
      VH,
      false
    );
    expect(released).toEqual(crept);
    expect(Math.abs(precisionOffset().x)).toBeGreaterThan(50);
  });

  it("recovers when the OS cursor is pinned at an edge (regression)", () => {
    // Model a real cursor: it cannot leave the screen, and a push past
    // the edge produces no event at all.
    let raw = 300;
    const hand = (dx: number, precision: boolean) => {
      const next = Math.min(Math.max(raw + dx, 0), VW - 1);
      if (next === raw) return null; // pinned — no pointermove fires
      raw = next;
      return move({ x: raw, y: 300 }, precision);
    };

    hand(0, false);
    hand(-1, false);
    for (let i = 0; i < 10; i++) hand(-30, true); // sweep left under precision
    expect(raw).toBeLessThan(5); // cursor is jammed at the left edge
    expect(precisionOffset().x).toBeGreaterThan(100); // reticle far inland

    // Release outside an interaction → the overlay calls sync.
    syncPrecisionPointer();

    // The reticle now sits on the cursor, so the very next move tracks
    // it exactly. Pre-fix this stayed frozen ~250 px away forever.
    const after = hand(40, false);
    expect(after).toEqual({ x: raw, y: 300 });
  });

  it("caps the divergence so a held modifier can't strand the cursor", () => {
    move({ x: 900, y: 400 }, false);
    // Way more damped travel than any real fine-adjustment.
    for (let i = 1; i <= 40; i++) move({ x: 900 - i * 20, y: 400 }, true);
    expect(Math.abs(precisionOffset().x)).toBeLessThanOrEqual(160);
  });

  it("drops the divergence on reset", () => {
    move({ x: 400, y: 400 }, false);
    move({ x: 600, y: 400 }, true);
    resetPrecisionPointer();
    expect(precisionOffset()).toEqual({ x: 0, y: 0 });
    move({ x: 800, y: 800 }, false);
    expect(move({ x: 810, y: 810 }, false)).toEqual({ x: 810, y: 810 });
  });
});
