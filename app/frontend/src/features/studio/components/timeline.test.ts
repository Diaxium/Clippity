import { describe, expect, it } from "vitest";

import { rulerTicks } from "./Timeline";

/** The gap between consecutive ticks, which must be uniform. */
function interval(ticks: number[]): number {
  const [first, second] = ticks;
  return first !== undefined && second !== undefined ? second - first : 0;
}

/** Every consecutive gap, so the uniformity check never indexes blind. */
function gaps(ticks: number[]): number[] {
  return ticks.slice(1).map((tick, i) => tick - ticks[i]!);
}

describe("rulerTicks", () => {
  it("starts at zero and steps uniformly", () => {
    const ticks = rulerTicks(10_000);
    expect(ticks[0]).toBe(0);
    for (const gap of gaps(ticks)) {
      expect(gap).toBe(interval(ticks));
    }
  });

  it("lands on intervals a human reads as round", () => {
    // The point of the ladder: 0:05 / 0:10 / 0:15, never 0:04.37.
    const ladder = [
      100, 250, 500, 1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000,
      120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000,
    ];
    for (const duration of [
      3_000, 12_000, 45_000, 90_000, 600_000, 7_200_000,
    ]) {
      expect(ladder).toContain(interval(rulerTicks(duration)));
    }
  });

  it("keeps roughly the target spacing across wildly different lengths", () => {
    // A five-second clip and a two-hour one should both get a readable
    // handful of labels — not two on one and four hundred on the other.
    for (const duration of [5_000, 60_000, 600_000, 7_200_000]) {
      const count = rulerTicks(duration).length;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(16);
    }
  });

  it("stops short of the end so the last label is not half off the track", () => {
    const duration = 10_000;
    for (const tick of rulerTicks(duration)) {
      expect(tick).toBeLessThan(duration);
    }
  });

  it("scales its count with the available width", () => {
    expect(rulerTicks(60_000, 1_800).length).toBeGreaterThan(
      rulerTicks(60_000, 400).length
    );
  });

  it("has nothing to draw before the duration is known", () => {
    // The timeline renders before the probe resolves.
    expect(rulerTicks(0)).toEqual([]);
    expect(rulerTicks(10_000, 0)).toEqual([]);
  });
});
