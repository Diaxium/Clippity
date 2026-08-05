import { beforeEach, describe, expect, it } from "vitest";

import { useStudioStore } from "./studioStore";
import type { MediaInfo } from "@services/tauri/clients/media";

const INFO: MediaInfo = {
  id: "C:/caps/Rec.mp4",
  token: 1,
  width: 1920,
  height: 1080,
  durationMs: 6_000,
  fps: 30,
  hasAudio: false,
};

const store = () => useStudioStore.getState();

/**
 * Who owns the playhead during a drag.
 *
 * The bug: dragging the playhead towards the start of a clip, it would
 * stick roughly half a second in and refuse to go further, jittering.
 *
 * A drag seeks the element on every pointer move, but an element seeks
 * *asynchronously* — `seeked` and `timeupdate` arrive afterwards
 * carrying the position it has just finished reaching, not the one the
 * pointer is at now. Written back, that stale position overwrites the
 * fresh one. Dragging towards zero, every late report is larger than
 * where the pointer has got to, so the playhead is repeatedly dragged
 * forwards again and never arrives.
 */
describe("scrubbing ownership", () => {
  beforeEach(() => {
    store().reset();
    store().open(INFO.id);
    store().loaded(INFO);
  });

  it("ignores the element's position while the playhead is being dragged", () => {
    store().setScrubbing(true);
    store().seek(200);
    // The element catching up on an earlier seek, reporting where it
    // *was*. This is the write that used to win.
    store().syncPosition(2_500);
    expect(store().currentMs).toBe(200);
  });

  it("lets a drag reach zero against a stream of stale reports", () => {
    // The reported symptom, reproduced: each move is followed by a late
    // report from further along the clip.
    store().setScrubbing(true);
    for (const [target, stale] of [
      [1_200, 2_400],
      [800, 1_500],
      [400, 900],
      [0, 550],
    ]) {
      store().seek(target!);
      store().syncPosition(stale!);
    }
    expect(store().currentMs).toBe(0);
  });

  it("resumes mirroring the element once the drag ends", () => {
    store().setScrubbing(true);
    store().seek(1_000);
    store().setScrubbing(false);
    store().syncPosition(1_800);
    expect(store().currentMs).toBe(1_800);
  });

  it("still mirrors the element when no drag is in progress", () => {
    // The ordinary case must be untouched: playback is what moves the
    // playhead the rest of the time.
    store().syncPosition(3_000);
    expect(store().currentMs).toBe(3_000);
  });

  it("clamps a mirrored position to the clip", () => {
    store().syncPosition(99_000);
    expect(store().currentMs).toBe(6_000);
  });

  it("starts idle and resets to idle", () => {
    // A flag left set would freeze the playhead for the rest of the
    // session — it would stop following playback entirely.
    expect(store().scrubbing).toBe(false);
    store().setScrubbing(true);
    store().reset();
    expect(store().scrubbing).toBe(false);
  });
});
