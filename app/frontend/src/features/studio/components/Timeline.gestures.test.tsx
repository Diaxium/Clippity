import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { Timeline } from "./Timeline";
import { useStudioStore } from "../state/studioStore";
import type { MediaInfo } from "@services/tauri/clients/media";

const INFO: MediaInfo = {
  id: "C:/caps/Rec.mp4",
  token: 1,
  width: 1920,
  height: 1080,
  durationMs: 10_000,
  fps: 30,
  hasAudio: false,
};

/** Track geometry jsdom will not compute for us. */
const LEFT = 100;
const WIDTH = 500;

/**
 * The timeline's pointer gestures.
 *
 * These exist because of a bug that made the surface feel broken and was
 * invisible to every test: the selected band carried its own
 * `pointerdown` with a `stopPropagation`, and the band spans the whole
 * track until something has been trimmed — which is how every clip
 * opens. So no press ever reached the track's scrub handler. Clicking
 * the timeline did nothing at all, and the only way to place the
 * playhead was to play and pause at exactly the right instant.
 *
 * jsdom computes no layout, so the track's rect is stubbed. That is the
 * whole reason these can run at all — every position here is derived
 * from it.
 */
function renderTimeline() {
  const view = render(<Timeline />);
  // The scrollable track is the only element with a pointer-cursor box.
  const track = view.container.querySelector<HTMLElement>("div.cursor-pointer");
  if (!track) throw new Error("track not rendered");
  track.getBoundingClientRect = () =>
    ({
      left: LEFT,
      top: 0,
      width: WIDTH,
      height: 48,
      right: LEFT + WIDTH,
      bottom: 48,
      x: LEFT,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return { ...view, track };
}

/** Client x for a fraction of the track. */
const at = (fraction: number) => LEFT + WIDTH * fraction;

const store = () => useStudioStore.getState();

describe("Timeline gestures", () => {
  beforeEach(() => {
    act(() => {
      store().reset();
      store().open(INFO.id);
      store().loaded(INFO);
    });
  });

  it("moves the playhead to where the track is pressed", () => {
    // The regression. A full-width selection must not swallow the press.
    const { track } = renderTimeline();
    act(() => {
      fireEvent.pointerDown(track, { clientX: at(0.6), clientY: 10 });
    });
    expect(Math.round(store().currentMs)).toBe(6_000);
  });

  it("scrubs continuously while the pointer is dragged", () => {
    // What makes an exact frame reachable without pausing on it.
    const { track } = renderTimeline();
    act(() => {
      fireEvent.pointerDown(track, { clientX: at(0.1), clientY: 10 });
    });
    const seen: number[] = [];
    for (const fraction of [0.3, 0.5, 0.8]) {
      act(() => {
        fireEvent.pointerMove(track, { clientX: at(fraction), clientY: 10 });
      });
      seen.push(Math.round(store().currentMs));
    }
    expect(seen).toEqual([3_000, 5_000, 8_000]);
  });

  it("leaves a full-width selection alone while scrubbing across it", () => {
    // A selection that fills the clip has nowhere to slide, so the drag
    // belongs to the playhead.
    const { track } = renderTimeline();
    act(() => {
      fireEvent.pointerDown(track, { clientX: at(0.2), clientY: 10 });
      fireEvent.pointerMove(track, { clientX: at(0.7), clientY: 10 });
      fireEvent.pointerUp(track, { clientX: at(0.7), clientY: 10 });
    });
    expect(store().range).toEqual({ startMs: 0, endMs: 10_000 });
  });

  it("slides a selection that has room to move", () => {
    const { track } = renderTimeline();
    act(() => {
      store().setRange({ startMs: 2_000, endMs: 5_000 });
    });
    act(() => {
      // Press inside the selection, then drag well past the threshold.
      fireEvent.pointerDown(track, { clientX: at(0.35), clientY: 10 });
      fireEvent.pointerMove(track, { clientX: at(0.45), clientY: 10 });
      fireEvent.pointerMove(track, { clientX: at(0.55), clientY: 10 });
    });
    const { startMs, endMs } = store().range;
    expect(startMs).toBeGreaterThan(2_000);
    expect(endMs - startMs).toBe(3_000);
  });

  it("scrubs rather than sliding when the press lands outside the selection", () => {
    const { track } = renderTimeline();
    act(() => {
      store().setRange({ startMs: 2_000, endMs: 5_000 });
    });
    act(() => {
      fireEvent.pointerDown(track, { clientX: at(0.85), clientY: 10 });
      fireEvent.pointerMove(track, { clientX: at(0.9), clientY: 10 });
    });
    expect(store().range).toEqual({ startMs: 2_000, endMs: 5_000 });
    expect(Math.round(store().currentMs)).toBe(9_000);
  });

  it("does not treat the tremor in a click as a slide", () => {
    // Below the threshold the gesture is still a press, so a click that
    // wobbles by a pixel must not nudge the selection.
    const { track } = renderTimeline();
    act(() => {
      store().setRange({ startMs: 2_000, endMs: 5_000 });
    });
    act(() => {
      fireEvent.pointerDown(track, { clientX: at(0.35), clientY: 10 });
      fireEvent.pointerMove(track, { clientX: at(0.35) + 2, clientY: 10 });
      fireEvent.pointerUp(track, { clientX: at(0.35) + 2, clientY: 10 });
    });
    expect(store().range).toEqual({ startMs: 2_000, endMs: 5_000 });
  });

  it("offers a grab bar only when the selection has room to move", () => {
    // A control that cannot do anything is worse than no control.
    const { container, rerender } = renderTimeline();
    expect(container.querySelector('[aria-label="Move selection"]')).toBeNull();

    act(() => {
      store().setRange({ startMs: 2_000, endMs: 5_000 });
    });
    rerender(<Timeline />);
    expect(
      container.querySelector('[aria-label="Move selection"]')
    ).not.toBeNull();
  });

  it("slides from the grab bar without a threshold, and without scrubbing", () => {
    // The bar means one thing, so it acts at once — and grabbing it must
    // move the selection, not the playhead.
    const { container, track, rerender } = renderTimeline();
    act(() => {
      store().setRange({ startMs: 2_000, endMs: 5_000 });
      store().seek(500);
    });
    rerender(<Timeline />);
    const grip = container.querySelector('[aria-label="Move selection"]');
    if (!grip) throw new Error("grab bar not rendered");

    const playheadBefore = store().currentMs;
    act(() => {
      fireEvent.pointerDown(grip, { clientX: at(0.35), clientY: 2 });
      fireEvent.pointerMove(track, { clientX: at(0.45), clientY: 2 });
    });
    const { startMs, endMs } = store().range;
    expect(startMs).toBeCloseTo(3_000, -2);
    expect(endMs - startMs).toBe(3_000);
    expect(store().currentMs).toBe(playheadBefore);
  });

  it("releases the gesture so the next press starts clean", () => {
    // A stuck gesture used to leave the timeline dead: the old scrub
    // handler refused to seek while one was in progress.
    const { track } = renderTimeline();
    act(() => {
      fireEvent.pointerDown(track, { clientX: at(0.2), clientY: 10 });
      fireEvent.pointerUp(track, { clientX: at(0.2), clientY: 10 });
      fireEvent.pointerDown(track, { clientX: at(0.9), clientY: 10 });
    });
    expect(Math.round(store().currentMs)).toBe(9_000);
    expect(store().dragging).toBeNull();
  });
});
