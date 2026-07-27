import { describe, expect, it } from "vitest";

import {
  dockTargetAt,
  DOCK_SNAP_PX,
  shouldUndock,
  UNDOCK_PULL_PX,
} from "./dock";

// A roomy workspace: both edge bands fit with a dead zone between them.
const LEFT = 200;
const RIGHT = 1400;

describe("dockTargetAt", () => {
  it("snaps to the edge the pointer is inside the band of", () => {
    expect(dockTargetAt(LEFT + 4, LEFT, RIGHT)).toBe("left");
    expect(dockTargetAt(RIGHT - 4, LEFT, RIGHT)).toBe("right");
  });

  it("snaps exactly at the threshold, and not one pixel past it", () => {
    expect(dockTargetAt(LEFT + DOCK_SNAP_PX, LEFT, RIGHT)).toBe("left");
    expect(dockTargetAt(LEFT + DOCK_SNAP_PX + 1, LEFT, RIGHT)).toBeNull();
    expect(dockTargetAt(RIGHT - DOCK_SNAP_PX, LEFT, RIGHT)).toBe("right");
    expect(dockTargetAt(RIGHT - DOCK_SNAP_PX - 1, LEFT, RIGHT)).toBeNull();
  });

  it("leaves the middle floating", () => {
    expect(dockTargetAt((LEFT + RIGHT) / 2, LEFT, RIGHT)).toBeNull();
  });

  it("does not snap from outside the container", () => {
    expect(dockTargetAt(LEFT - 10, LEFT, RIGHT)).toBeNull();
    expect(dockTargetAt(RIGHT + 10, LEFT, RIGHT)).toBeNull();
  });

  it("never reports both edges when the bands would overlap", () => {
    // Container narrower than 2× the threshold: the naive band test would match
    // left AND right in the middle. The midpoint split keeps it unambiguous.
    const l = 0;
    const r = DOCK_SNAP_PX; // half the width the two bands need
    expect(dockTargetAt(1, l, r)).toBe("left");
    expect(dockTargetAt(r - 1, l, r)).toBe("right");
    // Dead centre resolves one way, not both, and not null.
    expect(dockTargetAt(r / 2, l, r)).toBe("right");
  });

  it("returns null for a degenerate container", () => {
    expect(dockTargetAt(5, 100, 100)).toBeNull();
    expect(dockTargetAt(5, 100, 0)).toBeNull();
  });
});

describe("shouldUndock", () => {
  it("undocks a right rail only when dragged far enough inward", () => {
    expect(shouldUndock("right", 1400, 1400 - UNDOCK_PULL_PX)).toBe(true);
    expect(shouldUndock("right", 1400, 1400 - UNDOCK_PULL_PX + 1)).toBe(false);
  });

  it("undocks a left rail on the mirrored gesture", () => {
    expect(shouldUndock("left", 200, 200 + UNDOCK_PULL_PX)).toBe(true);
    expect(shouldUndock("left", 200, 200 + UNDOCK_PULL_PX - 1)).toBe(false);
  });

  it("ignores a pull outward, so nudging a rail never floats it", () => {
    expect(shouldUndock("right", 1400, 1400 + 500)).toBe(false);
    expect(shouldUndock("left", 200, 200 - 500)).toBe(false);
  });

  it("needs a bigger pull than a snap, so the gestures can't fight", () => {
    // Undocking must not immediately re-satisfy dockTargetAt at the same point.
    expect(UNDOCK_PULL_PX).toBeGreaterThan(DOCK_SNAP_PX);
  });
});
