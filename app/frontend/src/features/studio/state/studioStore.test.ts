import { beforeEach, describe, expect, it } from "vitest";

import type { MediaInfo } from "@services/tauri/clients/media";

import { useStudioStore } from "./studioStore";

const CLIP: MediaInfo = {
  id: "C:/caps/Rec.mp4",
  token: 1,
  width: 1920,
  height: 1080,
  durationMs: 10_000,
  fps: 30,
  hasAudio: true,
};

const store = () => useStudioStore.getState();

beforeEach(() => {
  store().reset();
});

describe("loading a clip", () => {
  it("starts the range as the whole clip", () => {
    store().open(CLIP.id);
    store().loaded(CLIP);
    expect(store().status).toBe("ready");
    expect(store().range).toEqual({ startMs: 0, endMs: 10_000 });
  });

  it("keeps the trim when the same clip is re-opened", () => {
    // The dashboard re-emits its view request on every cross-window
    // jump, including ones that land back here — that must not silently
    // discard in/out points the user placed.
    store().open(CLIP.id);
    store().loaded(CLIP);
    store().setRange({ startMs: 2_000, endMs: 6_000 });

    store().open(CLIP.id);
    expect(store().range).toEqual({ startMs: 2_000, endMs: 6_000 });
    expect(store().status).toBe("ready");
  });

  it("discards the trim when a different clip is opened", () => {
    store().open(CLIP.id);
    store().loaded(CLIP);
    store().setRange({ startMs: 2_000, endMs: 6_000 });

    store().open("C:/caps/Other.mp4");
    expect(store().status).toBe("loading");
    expect(store().info).toBeNull();
    expect(store().range).toEqual({ startMs: 0, endMs: 0 });
  });

  it("clears the clip on failure so the stage cannot show a stale one", () => {
    store().open(CLIP.id);
    store().loaded(CLIP);
    store().failed("nope");
    expect(store().status).toBe("error");
    expect(store().error).toBe("nope");
    expect(store().info).toBeNull();
  });
});

describe("seeking", () => {
  beforeEach(() => {
    store().open(CLIP.id);
    store().loaded(CLIP);
  });

  it("moves the mirrored position immediately, not only on the element's event", () => {
    // Waiting for `seeked` would let the playhead visibly lag the click
    // that placed it.
    store().seek(4_000);
    expect(store().currentMs).toBe(4_000);
    expect(store().seekMs).toBe(4_000);
  });

  it("bumps the nonce so seeking to where you already are still fires", () => {
    // Pressing Home twice, or clicking the in-point the playhead has
    // drifted onto, would otherwise be a no-op.
    store().seek(4_000);
    const first = store().seekNonce;
    store().seek(4_000);
    expect(store().seekNonce).toBe(first + 1);
  });

  it("holds a seek inside the clip", () => {
    store().seek(-500);
    expect(store().currentMs).toBe(0);
    store().seek(99_999);
    expect(store().currentMs).toBe(10_000);
  });

  it("clamps a reported position to the clip", () => {
    // `currentTime` can overshoot the declared duration by a frame.
    store().syncPosition(10_500);
    expect(store().currentMs).toBe(10_000);
  });
});

describe("relative moves", () => {
  beforeEach(() => {
    store().open(CLIP.id);
    store().loaded(CLIP);
  });

  it("compounds repeated frame steps within a single tick", () => {
    // The regression this exists for: a component computes its handler
    // from the position it *rendered* with, so three rapid clicks all
    // stepped from the same stale value and advanced one frame between
    // them. Reading the live position inside the action is the fix.
    store().stepFrames(1);
    store().stepFrames(1);
    store().stepFrames(1);
    expect(store().currentMs).toBeCloseTo(100, 0); // three frames at 30fps
  });

  it("compounds repeated nudges within a single tick", () => {
    store().nudge(1_000);
    store().nudge(1_000);
    expect(store().currentMs).toBe(2_000);
  });

  it("holds a relative move inside the clip", () => {
    store().nudge(-5_000);
    expect(store().currentMs).toBe(0);
    store().nudge(99_999);
    expect(store().currentMs).toBe(10_000);
  });

  it("puts a handle at the playhead without letting it cross the other", () => {
    store().seek(9_999);
    store().setHandleToPlayhead("in");
    // Stopped short of the out-point rather than crossing it.
    expect(store().range.startMs).toBeLessThan(store().range.endMs);
    expect(store().range.endMs).toBe(10_000);
  });

  it("ignores a relative move before a clip is loaded", () => {
    store().reset();
    store().stepFrames(1);
    store().setHandleToPlayhead("in");
    expect(store().currentMs).toBe(0);
  });
});

describe("audio", () => {
  it("mutes when the volume is dragged to zero", () => {
    store().setVolume(0);
    expect(store().muted).toBe(true);
  });

  it("unmutes when the volume is dragged back up", () => {
    store().setMuted(true);
    store().setVolume(0.3);
    expect(store().muted).toBe(false);
  });

  it("clamps volume to the usable range", () => {
    store().setVolume(5);
    expect(store().volume).toBe(1);
    store().setVolume(-1);
    expect(store().volume).toBe(0);
  });

  it("keeps the mute flag agreeing with the volume it actually set", () => {
    // An out-of-range drag clamps to zero; reading `muted` off the raw
    // argument instead would leave the player silent while still showing
    // an unmuted speaker.
    store().setVolume(-1);
    expect(store().volume).toBe(0);
    expect(store().muted).toBe(true);
  });

  it("survives loading a different clip", () => {
    // The element resets to full volume on mount; the store is what
    // remembers what the user chose.
    store().setVolume(0.3);
    store().setMuted(true);
    store().open("C:/caps/Other.mp4");
    expect(store().muted).toBe(true);
    expect(store().volume).toBe(0.3);
  });
});

describe("resetRange", () => {
  it("returns the range to the whole clip", () => {
    store().open(CLIP.id);
    store().loaded(CLIP);
    store().setRange({ startMs: 1_000, endMs: 2_000 });
    store().resetRange();
    expect(store().range).toEqual({ startMs: 0, endMs: 10_000 });
  });
});
