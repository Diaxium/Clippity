import { describe, expect, it } from "vitest";

import type { CaptureMeta } from "../types";
import { takeSections, type Section } from "./paging";

/** `n` throwaway captures — only identity and count matter here. */
function caps(prefix: string, n: number): CaptureMeta[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    title: `${prefix}-${i}`,
    kind: "image" as const,
    createdAtMs: i,
    sizeBytes: 1,
    trashed: false,
  }));
}

const sections = (): Section[] => [
  { key: "a", heading: "Today", items: caps("a", 3) },
  { key: "b", heading: "Yesterday", items: caps("b", 4) },
  { key: "c", heading: "Older", items: caps("c", 2) },
];

const flatIds = (list: Section[]) => list.flatMap((s) => s.items.map((m) => m.id));

describe("takeSections", () => {
  it("renders nothing at a zero budget", () => {
    expect(takeSections(sections(), 0)).toEqual([]);
  });

  it("keeps the whole list once the budget covers it", () => {
    const all = sections();
    expect(takeSections(all, 9)).toEqual(all);
    expect(takeSections(all, 500)).toEqual(all);
  });

  it("truncates the section that straddles the budget and drops the rest", () => {
    const taken = takeSections(sections(), 5);
    expect(taken.map((s) => s.key)).toEqual(["a", "b"]);
    expect(taken.at(1)?.items).toHaveLength(2);
    expect(flatIds(taken)).toEqual(["a-0", "a-1", "a-2", "b-0", "b-1"]);
  });

  it("never leaves a heading over an empty section", () => {
    // 3 is exactly section a — b must not appear as an empty group.
    const taken = takeSections(sections(), 3);
    expect(taken.map((s) => s.key)).toEqual(["a"]);
    expect(taken.every((s) => s.items.length > 0)).toBe(true);
  });

  it("takes a strict prefix of the full order as the budget grows", () => {
    const all = sections();
    const full = flatIds(all);
    for (let limit = 1; limit <= full.length; limit += 1) {
      expect(flatIds(takeSections(all, limit))).toEqual(full.slice(0, limit));
    }
  });

  it("passes fully-included sections through by reference", () => {
    // Identity is what lets the memoized cards above the growth point
    // skip re-rendering when the budget grows.
    const all = sections();
    const taken = takeSections(all, 5);
    expect(taken[0]).toBe(all[0]);
    expect(taken[1]).not.toBe(all[1]);
  });
});
