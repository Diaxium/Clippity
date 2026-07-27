/**
 * How much of the shaped listing is actually mounted — the pure half of
 * the library's progressive rendering (performance roadmap P5).
 *
 * The grid's sections are computed over the *whole* filtered set, because
 * that is what every other consumer needs to be correct: the toolbar's
 * count, "Select all", a Shift-click range, and the inspector's lookup
 * all mean "every capture this scope shows", not "every capture drawn so
 * far". Only the *rendering* is bounded — `takeSections` is the seam
 * where a 50k-row listing becomes a screenful of DOM.
 */

import type { CaptureMeta } from "../types";

/** One rendered group: a day of the library, a whole collection, or —
 *  under a non-chronological sort — the single flat run. */
export interface Section {
  key: string;
  heading: string | null;
  items: CaptureMeta[];
}

/**
 * The first `limit` captures of `sections`, keeping the grouping intact.
 *
 * Sections are consumed whole until the budget runs out; the one that
 * straddles it is truncated, and everything past it is dropped. A day
 * heading therefore never appears over an empty grid, and the visible
 * order is a strict prefix of the full order — the user scrolls into
 * more of the same list rather than watching it re-arrange.
 *
 * A section that fits entirely is passed through **by reference** rather
 * than copied, so the memoized card subtrees above the growth point keep
 * their identity and don't re-render each time the budget grows.
 */
export function takeSections(sections: Section[], limit: number): Section[] {
  if (limit <= 0) return [];
  const out: Section[] = [];
  let left = limit;
  for (const section of sections) {
    if (left <= 0) break;
    if (section.items.length <= left) {
      out.push(section);
      left -= section.items.length;
    } else {
      out.push({ ...section, items: section.items.slice(0, left) });
      left = 0;
    }
  }
  return out;
}
