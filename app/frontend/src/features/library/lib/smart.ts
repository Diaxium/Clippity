/**
 * Smart collections — the sidebar's derived sets. Pure predicates, no
 * React, no IPC.
 *
 * A smart collection is a rule evaluated against the listing the page
 * already holds, not a stored document: nothing is written when a
 * capture starts or stops matching, and "This week" means whatever this
 * week means at the moment it renders. That is the whole distinction
 * from a `Collection`, which remembers an arrangement the user built and
 * would be destroyed by re-deriving it.
 *
 * `now` is a parameter rather than a `Date.now()` call inside each
 * predicate so a screenful of rows shares one clock — a list that
 * straddled midnight mid-render would otherwise put two captures a
 * millisecond apart in different weeks — and so the tests can pin it.
 */

import type { LibraryFacetsQuery } from "@services/tauri/clients/library";

import type { CaptureMeta, SmartId } from "../types";
import { startOfDay } from "./format";

/** What counts as a large capture. A 4K PNG lands around 6–10 MB and a
 *  short screen recording clears this immediately, so the set stays the
 *  handful of files actually worth pruning rather than half the library. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;

export interface SmartDef {
  id: SmartId;
  label: string;
}

/** The smart collections the sidebar offers, in display order. */
export const SMART_COLLECTIONS: readonly SmartDef[] = [
  { id: "this-week", label: "This week" },
  { id: "last-30-days", label: "Last 30 days" },
  { id: "large", label: "Large files" },
  { id: "untagged", label: "Untagged" },
];

/**
 * Does `meta` belong to the smart collection `id`?
 *
 * The two time windows are anchored differently on purpose. "This week"
 * counts back seven *calendar days* from local midnight, so a capture
 * taken at 9am today and one taken at 11pm six days ago are both in it
 * regardless of the current hour — a rolling 168-hour window would drop
 * rows out of the set as the afternoon wore on. "Last 30 days" is a
 * plain rolling window, which is what a month-scale bucket is read as.
 */
export function matchesSmart(
  meta: CaptureMeta,
  id: SmartId,
  now: number = Date.now()
): boolean {
  switch (id) {
    case "this-week":
      return meta.createdAtMs >= thisWeekSince(now);
    case "last-30-days":
      return meta.createdAtMs >= last30DaysSince(now);
    case "large":
      return meta.sizeBytes >= LARGE_FILE_BYTES;
    case "untagged":
      return (meta.tags ?? []).length === 0;
  }
}

/** Start of "this week" — see [`matchesSmart`] for why it is anchored to
 *  local midnight rather than a rolling 168 hours. */
const thisWeekSince = (now: number) => startOfDay(now) - 6 * 86_400_000;

/** Start of "last 30 days" — a plain rolling window. */
const last30DaysSince = (now: number) => now - 30 * 86_400_000;

/**
 * The same boundaries as {@link matchesSmart}, in the shape the backend's
 * facet counts take.
 *
 * The rail's counts span the whole library, so they are aggregated in SQL
 * rather than by filtering a listing the client no longer holds — but the
 * *cut points* stay here, because they depend on the user's clock and
 * local midnight, which the backend cannot compute. Both readings of a
 * window therefore come from these two functions; a test pins the counts
 * to the predicate so the rail can never disagree with the grid it opens.
 */
export function smartThresholds(now: number = Date.now()): LibraryFacetsQuery {
  return {
    thisWeekSinceMs: thisWeekSince(now),
    last30DaysSinceMs: last30DaysSince(now),
    largeMinBytes: LARGE_FILE_BYTES,
  };
}
