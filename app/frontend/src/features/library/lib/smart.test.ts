import { describe, expect, it } from "vitest";

import type { CaptureMeta, SmartId } from "../types";
import { LARGE_FILE_BYTES, matchesSmart, smartThresholds } from "./smart";

const NOON = new Date(2026, 5, 15, 12, 0, 0).getTime();

function cap(overrides: Partial<CaptureMeta> = {}): CaptureMeta {
  return {
    id: "/caps/a.png",
    title: "a",
    kind: "image",
    createdAtMs: NOON,
    sizeBytes: 1_000,
    trashed: false,
    ...overrides,
  };
}

describe("smartThresholds", () => {
  it("cuts each window where matchesSmart does", () => {
    const t = smartThresholds(NOON);

    // A capture exactly on a boundary is in; one a millisecond earlier
    // is out. Asserted through the predicate so the two readings of a
    // window are compared, not just the arithmetic restated.
    const onWeek = cap({ createdAtMs: t.thisWeekSinceMs });
    const beforeWeek = cap({ createdAtMs: t.thisWeekSinceMs - 1 });
    expect(matchesSmart(onWeek, "this-week", NOON)).toBe(true);
    expect(matchesSmart(beforeWeek, "this-week", NOON)).toBe(false);

    const onMonth = cap({ createdAtMs: t.last30DaysSinceMs });
    const beforeMonth = cap({ createdAtMs: t.last30DaysSinceMs - 1 });
    expect(matchesSmart(onMonth, "last-30-days", NOON)).toBe(true);
    expect(matchesSmart(beforeMonth, "last-30-days", NOON)).toBe(false);

    expect(matchesSmart(cap({ sizeBytes: t.largeMinBytes }), "large")).toBe(
      true
    );
    expect(matchesSmart(cap({ sizeBytes: t.largeMinBytes - 1 }), "large")).toBe(
      false
    );
  });

  it("agrees with the predicate across a spread of captures", () => {
    // The property that matters: counting with the thresholds (what the
    // backend does for the rail) and filtering with the predicate (what
    // the grid does) must never disagree, or a rail row would open a
    // grid of a different size.
    const day = 86_400_000;
    const rows = [0, 1, 3, 6, 7, 10, 29, 31, 400].map((daysAgo) =>
      cap({
        id: `/caps/${daysAgo}.png`,
        createdAtMs: NOON - daysAgo * day,
        sizeBytes: daysAgo % 2 === 0 ? LARGE_FILE_BYTES + 1 : 10,
        tags: daysAgo % 3 === 0 ? [] : ["bug"],
      })
    );
    const t = smartThresholds(NOON);

    const byThreshold = {
      "this-week": rows.filter((m) => m.createdAtMs >= t.thisWeekSinceMs).length,
      "last-30-days": rows.filter((m) => m.createdAtMs >= t.last30DaysSinceMs)
        .length,
      large: rows.filter((m) => m.sizeBytes >= t.largeMinBytes).length,
      untagged: rows.filter((m) => (m.tags ?? []).length === 0).length,
    };

    for (const id of Object.keys(byThreshold) as SmartId[]) {
      const byPredicate = rows.filter((m) => matchesSmart(m, id, NOON)).length;
      expect(byPredicate, `${id} count`).toBe(byThreshold[id]);
    }
  });

  it("anchors this week to local midnight, not a rolling 168 hours", () => {
    // Two captures the same distance back in hours but either side of a
    // midnight must not both be "this week" — the window is calendar
    // days, so the boundary is a date, not an elapsed duration.
    const t = smartThresholds(NOON);
    const midnight = new Date(2026, 5, 15).getTime();
    expect(t.thisWeekSinceMs).toBe(midnight - 6 * 86_400_000);
    expect(t.largeMinBytes).toBe(LARGE_FILE_BYTES);
  });
});
