import { describe, expect, it } from "vitest";

import type {
  RecorderFormat,
  RecorderTarget,
} from "@services/tauri/clients/recorder";

import {
  AVAILABLE_RECORD_FORMATS,
  AVAILABLE_RECORD_TARGETS,
  OVERLAY_MODE_FOR_TARGET,
  RECORD_FORMATS,
  RECORD_TARGETS,
  recordReadiness,
  visibleRecordOptionKeys,
} from "./recordModes";

describe("RECORD_TARGETS / RECORD_FORMATS", () => {
  it("arms all three targets", () => {
    for (const id of ["fullscreen", "region", "window"] as const) {
      expect(AVAILABLE_RECORD_TARGETS.has(id), id).toBe(true);
    }
  });

  it("gives any unavailable tile a reason", () => {
    // Nothing is unavailable today, but the rule has to hold: a "Soon"
    // tile with no explanation reads as a bug rather than a deferral.
    for (const def of RECORD_TARGETS) {
      if (!def.available) expect(def.unavailableHint).toBeTruthy();
    }
  });

  it("routes only region and window through the overlay", () => {
    // Fullscreen has nothing to select, so bouncing it through a
    // selection surface would add a step for no decision.
    expect(OVERLAY_MODE_FOR_TARGET.fullscreen).toBeNull();
    expect(OVERLAY_MODE_FOR_TARGET.region).toBe("record-region");
    expect(OVERLAY_MODE_FOR_TARGET.window).toBe("record-window");
  });

  it("maps every target to a routing decision", () => {
    // A target missing from the map would silently start nothing.
    for (const def of RECORD_TARGETS) {
      expect(def.id in OVERLAY_MODE_FOR_TARGET, def.id).toBe(true);
    }
  });

  it("makes both output formats armable", () => {
    expect(AVAILABLE_RECORD_FORMATS.has("mp4")).toBe(true);
    expect(AVAILABLE_RECORD_FORMATS.has("gif")).toBe(true);
  });

  it("gives every tile a label and a description", () => {
    for (const def of [...RECORD_TARGETS, ...RECORD_FORMATS]) {
      expect(def.label).toBeTruthy();
      expect(def.desc).toBeTruthy();
    }
  });
});

describe("visibleRecordOptionKeys", () => {
  it("offers both audio inputs for video", () => {
    const keys = visibleRecordOptionKeys("mp4");
    expect(keys.has("microphone")).toBe(true);
    expect(keys.has("systemAudio")).toBe(true);
  });

  it("keeps sources on both formats", () => {
    // A GIF is still a picture of the screen — a webcam in the corner
    // is as meaningful there as in a video.
    expect(visibleRecordOptionKeys("mp4").has("sources")).toBe(true);
    expect(visibleRecordOptionKeys("gif").has("sources")).toBe(true);
  });

  it("offers an encoder quality step for video only", () => {
    // Quality scales an H.264 bitrate; GIF has none.
    expect(visibleRecordOptionKeys("mp4").has("quality")).toBe(true);
    expect(visibleRecordOptionKeys("gif").has("quality")).toBe(false);
  });

  it("offers a resolution cap for video only", () => {
    // GIF's own pixel budget is under every height the menu offers, so
    // the control would never change the file.
    expect(visibleRecordOptionKeys("mp4").has("resolution")).toBe(true);
    expect(visibleRecordOptionKeys("gif").has("resolution")).toBe(false);
  });

  it("hides audio entirely for GIF", () => {
    // GIF has no audio track — a toggle here would promise something
    // nothing keeps.
    const keys = visibleRecordOptionKeys("gif");
    expect(keys.has("microphone")).toBe(false);
    expect(keys.has("systemAudio")).toBe(false);
  });

  it("keeps cursor, outline and frame rate for both formats", () => {
    // The outline frames whatever is being recorded, so it is as
    // meaningful for a GIF as for a video — unlike audio.
    for (const format of ["mp4", "gif"] as const) {
      const keys = visibleRecordOptionKeys(format);
      expect(keys.has("cursor"), format).toBe(true);
      expect(keys.has("outline"), format).toBe(true);
      expect(keys.has("fps"), format).toBe(true);
    }
  });
});

describe("recordReadiness", () => {
  it("is ready for every shipped target and format combination", () => {
    for (const target of ["fullscreen", "region", "window"] as const) {
      for (const format of ["mp4", "gif"] as const) {
        expect(recordReadiness(target, format), `${target}/${format}`).toEqual({
          ready: true,
        });
      }
    }
  });

  it("blocks a target that isn't in the armable set", () => {
    // Exercises the refusal branch with a target the set doesn't hold —
    // the state a not-yet-shipped tile would put the footer in. Every
    // shipped target is armable today, so this is the only way to reach
    // it, and it must not be reachable by accident.
    const bogus = "picture-in-picture" as RecorderTarget;
    const { ready, reason } = recordReadiness(bogus, "mp4");
    expect(ready).toBe(false);
    expect(reason).toBeTruthy();
  });

  it("blocks a format that isn't in the armable set", () => {
    const bogus = "webm" as RecorderFormat;
    expect(recordReadiness("fullscreen", bogus).ready).toBe(false);
  });
});
