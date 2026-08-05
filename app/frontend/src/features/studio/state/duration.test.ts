import { beforeEach, describe, expect, it } from "vitest";

import { useStudioStore } from "./studioStore";
import type { MediaInfo } from "@services/tauri/clients/media";

/** A clip whose container header claims five seconds. */
const INFO: MediaInfo = {
  id: "C:/caps/Rec.mp4",
  token: 1,
  width: 1920,
  height: 1080,
  durationMs: 5_000,
  fps: 30,
  hasAudio: false,
};

const store = () => useStudioStore.getState();

/**
 * Adopting the element's duration over the container header's.
 *
 * The bug: a recording whose header said five seconds while only three
 * seconds of it existed. The timeline was drawn five seconds wide, so
 * playback stopped three-fifths of the way along a track that claimed
 * more, and every position on that track mapped to the wrong moment —
 * which is why the playhead could not be put anywhere exactly.
 *
 * The header is read before a frame is decoded, which is what makes a
 * timeline appear instantly; the element is what actually decodes. So
 * the header opens the surface and the element corrects it.
 */
describe("reconcileDuration", () => {
  beforeEach(() => {
    store().reset();
    store().open(INFO.id);
    store().loaded(INFO);
  });

  it("shortens the clip to what the element can actually play", () => {
    store().reconcileDuration(3_000);
    expect(store().info?.durationMs).toBe(3_000);
  });

  it("re-expands a full-span range to the corrected length", () => {
    // Nothing was trimmed, so the selection still means "all of it".
    expect(store().range).toEqual({ startMs: 0, endMs: 5_000 });
    store().reconcileDuration(3_000);
    expect(store().range).toEqual({ startMs: 0, endMs: 3_000 });
  });

  it("keeps in and out points the user placed, clamped to the new end", () => {
    // Discarding a deliberate trim because the file turned out shorter
    // than its header claimed is the ruder of the two options.
    store().setRange({ startMs: 1_000, endMs: 4_500 });
    store().reconcileDuration(3_000);
    expect(store().range).toEqual({ startMs: 1_000, endMs: 3_000 });
  });

  it("pulls the playhead back inside the corrected clip", () => {
    store().seek(4_800);
    store().reconcileDuration(3_000);
    expect(store().currentMs).toBeLessThanOrEqual(3_000);
  });

  it("also grows a clip whose header was short", () => {
    // The correction is not one-directional: a header can under-report
    // just as easily, and a timeline that stops early hides footage.
    store().reconcileDuration(9_000);
    expect(store().info?.durationMs).toBe(9_000);
    expect(store().range).toEqual({ startMs: 0, endMs: 9_000 });
  });

  it("ignores the values an element reports before it settles", () => {
    // A fragmented container reports `Infinity` until its end is known,
    // and `NaN` before metadata arrives. Either would blank the
    // timeline or make it infinitely long.
    for (const bogus of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      store().reconcileDuration(bogus);
      expect(store().info?.durationMs).toBe(5_000);
    }
  });

  it("ignores sub-millisecond disagreement", () => {
    // The header states whole milliseconds and the element works in
    // floating-point seconds, so they never agree exactly. Reacting to
    // that would rewrite the range on every `timeupdate`.
    store().setRange({ startMs: 500, endMs: 4_000 });
    store().reconcileDuration(5_000.4);
    expect(store().info?.durationMs).toBe(5_000);
    expect(store().range).toEqual({ startMs: 500, endMs: 4_000 });
  });

  it("does nothing before a clip is open", () => {
    store().reset();
    store().reconcileDuration(3_000);
    expect(store().info).toBeNull();
  });
});
