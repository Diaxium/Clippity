import { describe, expect, it } from "vitest";

import {
  clampMs,
  formatDuration,
  formatTimecode,
  fractionToMs,
  frameDurationMs,
  frameToMs,
  msToFraction,
  msToFrame,
  stepFrame,
} from "./time";

describe("frame arithmetic", () => {
  it("derives a frame's duration from the rate", () => {
    expect(frameDurationMs(30)).toBeCloseTo(33.333, 2);
    expect(frameDurationMs(60)).toBeCloseTo(16.667, 2);
  });

  it("falls back to a sane rate rather than dividing by zero", () => {
    // The backend guarantees a non-zero fps; an Infinity here would
    // propagate silently into every seek, so the guard is cheap.
    expect(frameDurationMs(0)).toBeCloseTo(33.333, 2);
    expect(frameDurationMs(-5)).toBeCloseTo(33.333, 2);
  });

  it("floors a position into the frame that is on screen", () => {
    // Mid-frame is still that frame, not the next one.
    expect(msToFrame(0, 30)).toBe(0);
    expect(msToFrame(33, 30)).toBe(0);
    expect(msToFrame(34, 30)).toBe(1);
  });

  it("round-trips a frame through its start position", () => {
    for (const frame of [0, 1, 29, 300]) {
      expect(msToFrame(frameToMs(frame, 30), 30)).toBe(frame);
    }
  });
});

describe("stepFrame", () => {
  const duration = 10_000;

  it("advances exactly one frame from a frame boundary", () => {
    expect(stepFrame(0, 30, 1, duration)).toBeCloseTo(33.333, 2);
  });

  it("advances from a mid-frame scrub position to the next frame", () => {
    // The bug this guards: without snapping first, stepping forward
    // from 20ms lands at 53ms — inside frame 1 either way, so the
    // picture never changes and the button looks dead.
    const next = stepFrame(20, 30, 1, duration);
    expect(msToFrame(next, 30)).toBe(1);
  });

  it("steps backwards to exactly the preceding frame", () => {
    const from = 100;
    const before = msToFrame(from, 30);
    expect(msToFrame(stepFrame(from, 30, -1, duration), 30)).toBe(before - 1);
  });

  it("returns to where it started after stepping out and back", () => {
    const start = stepFrame(1_000, 30, 0, duration);
    const roundTrip = stepFrame(
      stepFrame(start, 30, 4, duration),
      30,
      -4,
      duration
    );
    expect(msToFrame(roundTrip, 30)).toBe(msToFrame(start, 30));
  });

  it("cannot step before the start or past the end", () => {
    expect(stepFrame(0, 30, -1, duration)).toBe(0);
    expect(stepFrame(duration, 30, 5, duration)).toBe(duration);
  });
});

describe("clampMs", () => {
  it("holds a position inside the clip", () => {
    expect(clampMs(-50, 1_000)).toBe(0);
    expect(clampMs(5_000, 1_000)).toBe(1_000);
    expect(clampMs(500, 1_000)).toBe(500);
  });

  it("survives a non-finite position", () => {
    // `video.currentTime` is NaN before metadata loads.
    expect(clampMs(Number.NaN, 1_000)).toBe(0);
    expect(clampMs(Number.POSITIVE_INFINITY, 1_000)).toBe(0);
  });
});

describe("formatTimecode", () => {
  it("reads as M:SS.cc under an hour", () => {
    expect(formatTimecode(0)).toBe("0:00.00");
    expect(formatTimecode(1_230)).toBe("0:01.23");
    expect(formatTimecode(65_400)).toBe("1:05.40");
  });

  it("grows an hours field only when the clip needs one", () => {
    expect(formatTimecode(3_600_000)).toBe("1:00:00.00");
    expect(formatTimecode(3_725_500)).toBe("1:02:05.50");
  });

  it("keeps a fixed width so a live readout does not jitter", () => {
    // Every value under ten minutes must render the same length, or the
    // controls beside it shift as the clip plays.
    const widths = new Set(
      [0, 999, 5_000, 59_990, 65_400].map((ms) => formatTimecode(ms).length)
    );
    expect(widths.size).toBe(1);
  });

  it("treats a pre-metadata position as zero", () => {
    expect(formatTimecode(Number.NaN)).toBe("0:00.00");
    expect(formatTimecode(-1)).toBe("0:00.00");
  });
});

describe("formatDuration", () => {
  it("uses the unit that makes the number readable", () => {
    expect(formatDuration(320)).toBe("320ms");
    expect(formatDuration(4_500)).toBe("4.5s");
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(80_000)).toBe("1m 20s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("carries a rounded-up remainder into the next minute", () => {
    // 119.6s must not read as "1m 60s".
    expect(formatDuration(119_600)).toBe("2m");
  });

  it("drops a trailing zero decimal", () => {
    expect(formatDuration(3_000)).toBe("3s");
    expect(formatDuration(3_040)).toBe("3s");
  });
});

describe("track fractions", () => {
  it("round-trips a position through its fraction of the track", () => {
    expect(msToFraction(5_000, 10_000)).toBe(0.5);
    expect(fractionToMs(0.5, 10_000)).toBe(5_000);
  });

  it("clamps to the track at both ends", () => {
    // A pointer drag routinely leaves the element.
    expect(msToFraction(-100, 10_000)).toBe(0);
    expect(msToFraction(99_999, 10_000)).toBe(1);
    expect(fractionToMs(-0.5, 10_000)).toBe(0);
    expect(fractionToMs(1.5, 10_000)).toBe(10_000);
  });

  it("reports zero rather than dividing by an unknown duration", () => {
    // The timeline renders before metadata lands.
    expect(msToFraction(500, 0)).toBe(0);
  });
});
