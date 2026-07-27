import type { PointerEvent as PointerEventReact } from "react";

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useOverlayStore } from "../state/overlayStore";
import type { Rect } from "../types";
import { useRegionSelection } from "./useRegionSelection";

// Regression lock for the Step 4 canvas-pointer-up phase guard.
//
// Bug: `onPointerUp` used to call `endDrag(null)` whenever
// `phase !== "dragging"`. Pointer-up events from the BottomToolbar's
// Capture button and the Selection's resize/move handles bubble past
// their `stopPropagation` barriers via the React→DOM bridge and reach
// the canvas-wide handler — so the destructive branch would wipe the
// committed rect before `onCapture` could read it, and resize-handle
// drags would silently destroy the selection.
//
// Fix: early-return when phase is not "dragging". State only ever
// changes on a true drag end (rejected or accepted). These tests
// lock that in.

const initialStore = useOverlayStore.getState();

// The hook's `onPointerUp` does not read the event body — the guard
// only inspects store phase. Passing an empty stub keeps the test
// focused on the state-machine behaviour the regression depends on.
const stubEvent = {} as PointerEventReact;

describe("useRegionSelection — canvas pointer-up phase guard", () => {
  beforeEach(() => {
    useOverlayStore.setState(initialStore, true);
  });

  it("preserves the committed selection when phase is 'selected' (regression)", () => {
    // Arrange: commit a real selection so we're in phase=selected.
    const rect: Rect = { x: 100, y: 100, w: 400, h: 300 };
    useOverlayStore.getState().startDrag({ x: 100, y: 100 });
    useOverlayStore.getState().endDrag(rect);
    expect(useOverlayStore.getState().phase).toBe("selected");

    // Act: stray pointer-up reaches the canvas-wide handler — matches
    // the Capture-button / resize-handle bubble path from Step 4.
    const { result } = renderHook(() => useRegionSelection());
    result.current.onPointerUp(stubEvent);

    // Assert: rect survives, phase stays 'selected'. Pre-fix this used
    // to land in `phase: "idle"` with `rect: null`.
    expect(useOverlayStore.getState().phase).toBe("selected");
    expect(useOverlayStore.getState().rect).toEqual(rect);
  });

  it("leaves 'idle' phase alone (no second-pointerup churn)", () => {
    // Arrange: prior rejected drag landed us at idle with no rect.
    useOverlayStore.getState().startDrag({ x: 0, y: 0 });
    useOverlayStore.getState().endDrag(null);
    expect(useOverlayStore.getState().phase).toBe("idle");

    // Act + assert: stray pointer-up is a true no-op.
    const { result } = renderHook(() => useRegionSelection());
    result.current.onPointerUp(stubEvent);

    expect(useOverlayStore.getState().phase).toBe("idle");
    expect(useOverlayStore.getState().rect).toBeNull();
    expect(useOverlayStore.getState().start).toBeNull();
    expect(useOverlayStore.getState().cur).toBeNull();
  });

  it("still finalizes a real drag when phase is 'dragging' (sanity)", () => {
    // Arrange: live drag — start + cur both set, rect clears MIN_SIZE.
    useOverlayStore.getState().startDrag({ x: 10, y: 20 });
    useOverlayStore.getState().updateDrag({ x: 110, y: 120 });
    expect(useOverlayStore.getState().phase).toBe("dragging");

    // Act: legitimate canvas pointer-up commits the drag.
    const { result } = renderHook(() => useRegionSelection());
    result.current.onPointerUp(stubEvent);

    // Assert: phase advanced + rect equals the drag bounds.
    expect(useOverlayStore.getState().phase).toBe("selected");
    expect(useOverlayStore.getState().rect).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 100,
    });
  });

  it("rejects an undersized drag (still goes to idle)", () => {
    // Arrange: live drag, but the rect won't clear MIN_SIZE (2px).
    useOverlayStore.getState().startDrag({ x: 10, y: 20 });
    useOverlayStore.getState().updateDrag({ x: 12, y: 22 });
    expect(useOverlayStore.getState().phase).toBe("dragging");

    // Act: real pointer-up — but the rect is too small to commit.
    const { result } = renderHook(() => useRegionSelection());
    result.current.onPointerUp(stubEvent);

    // Assert: phase falls to idle, no rect. (The guard's destructive
    // branch is intentional here — this branch only runs when phase
    // IS dragging.)
    expect(useOverlayStore.getState().phase).toBe("idle");
    expect(useOverlayStore.getState().rect).toBeNull();
  });
});
