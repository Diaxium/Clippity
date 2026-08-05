import { describe, expect, it } from "vitest";

import { ipcPerSecond, summarizeFrames } from "./perfSampler";

describe("summarizeFrames", () => {
  it("reports nothing measured rather than a frozen app", () => {
    // A just-opened overlay has one timestamp; claiming "0 fps" there
    // would say the app is frozen when nothing has been measured yet.
    expect(summarizeFrames([])).toEqual({
      fps: 0,
      frameMs: 0,
      worstFrameMs: 0,
    });
    expect(summarizeFrames([16.7])).toEqual({
      fps: 0,
      frameMs: 0,
      worstFrameMs: 0,
    });
  });

  it("computes the rate over the window, not per pair", () => {
    // Six frames at 60 Hz: five intervals across 83.3 ms.
    const stamps = [0, 16.67, 33.34, 50.01, 66.68, 83.35];
    const { fps, frameMs } = summarizeFrames(stamps);
    expect(fps).toBeCloseTo(60, 1);
    expect(frameMs).toBeCloseTo(16.67, 1);
  });

  it("surfaces the worst interval, which is where a stutter lives", () => {
    const { fps, worstFrameMs } = summarizeFrames([0, 16, 32, 232, 248]);
    // The mean stays respectable while one frame took 200 ms — which is
    // the stutter a user actually felt.
    expect(worstFrameMs).toBe(200);
    expect(fps).toBeGreaterThan(10);
  });

  it("does not divide by a zero span", () => {
    expect(summarizeFrames([5, 5, 5])).toEqual({
      fps: 0,
      frameMs: 0,
      worstFrameMs: 0,
    });
  });
});

describe("ipcPerSecond", () => {
  it("counts only calls completed inside the window", () => {
    const samples = [{ at: 900 }, { at: 1_200 }, { at: 1_800 }];
    // Window 1000 → 2000 ms contains two of them.
    expect(ipcPerSecond(samples, 1_000, 2_000)).toBeCloseTo(2, 5);
  });

  it("is zero for an empty or inverted window", () => {
    expect(ipcPerSecond([], 1_000, 2_000)).toBe(0);
    expect(ipcPerSecond([{ at: 1_500 }], 2_000, 1_000)).toBe(0);
  });
});
