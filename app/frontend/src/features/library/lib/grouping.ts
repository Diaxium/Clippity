/**
 * Pure list-shaping helpers for the library grid. No React, no IPC.
 */

import type {
  CaptureKind,
  CaptureMeta,
  Collection,
  KindTab,
  LibraryMode,
  LibrarySort,
  SmartId,
} from "../types";
import { dayKey } from "./format";
import { matchesSmart } from "./smart";

/** Everything the page narrows the raw listing by. */
export interface LibraryFilter {
  mode: LibraryMode;
  kindFilter: KindTab;
  favoritesOnly: boolean;
  tagFilter: string | null;
  /** Active smart collection, or `null` for none. */
  smart?: SmartId | null;
  /** Free-text query from the search box. Blank / absent matches all. */
  search?: string;
  /** Clock for the time-window smart collections — one value for the
   *  whole pass. */
  now?: number;
}

/**
 * Filter the raw list down to the active mode + refinements.
 *
 * Mode: `library` shows non-trashed, `trash` shows trashed. (The
 * backend's `includeTrashed` flag controls whether trashed rows are
 * in the list at all; this is the frontend's view-level narrowing.)
 *
 * Kind: `all` passes everything; a specific kind keeps only matches.
 * Favorites, smart collection, tag and search are further refinements,
 * ANDed with the rest — "starred images tagged bug" is the intersection,
 * which is what a stack of active filter chips reads as.
 */
export function filterCaptures(
  items: CaptureMeta[],
  filter: LibraryFilter
): CaptureMeta[] {
  const now = filter.now ?? Date.now();
  const query = filter.search?.trim().toLowerCase() ?? "";
  return items.filter((m) => {
    if (filter.mode === "trash" ? !m.trashed : m.trashed) return false;
    if (filter.kindFilter !== "all" && m.kind !== filter.kindFilter)
      return false;
    if (filter.favoritesOnly && !m.favorite) return false;
    if (filter.smart && !matchesSmart(m, filter.smart, now)) return false;
    if (filter.tagFilter && !hasTag(m, filter.tagFilter)) return false;
    if (query && !matchesSearch(m, query)) return false;
    return true;
  });
}

/**
 * Does `meta` match the search box?
 *
 * Substring, case-insensitive, across everything the user can *see* or
 * plausibly remember about a capture: its title, its tags, the app and
 * window it came from, and — for aux entries, whose titles are generated
 * rather than named — the payload itself. That last part is what makes
 * the box useful for the non-file kinds: a palette is findable by any
 * one of its swatches (`#ff6e4a` finds the palette it came from, not
 * just the color entry), and a clipboard-text entry by its contents,
 * neither of which appears anywhere in a title. Deliberately not fuzzy:
 * on a list this size a typo-tolerant match mostly returns rows the user
 * did not ask for, and "why is that here?" is a worse failure than
 * "nothing found".
 *
 * `query` is expected pre-trimmed and lower-cased by the caller — this
 * runs once per row per keystroke, and re-normalising the needle each
 * time is the one wasteful thing in the loop.
 */
export function matchesSearch(meta: CaptureMeta, query: string): boolean {
  if (!query) return true;
  const haystack = [
    meta.title,
    meta.sourceApp,
    meta.sourceWindow,
    meta.mode,
    meta.text,
    meta.color?.hex,
    ...(meta.palette?.map((c) => c.hex) ?? []),
    ...(meta.tags ?? []),
  ];
  return haystack.some((part) => part?.toLowerCase().includes(query));
}

/**
 * Order a (pre-filtered) list.
 *
 * Copies rather than sorting in place — the caller's array is the
 * memoised filter output, and re-ordering it under React would leave a
 * previous render's list silently rearranged.
 *
 * `name` uses `localeCompare` so `clippity-2` sorts before `clippity-10`
 * with numeric collation, which is what a folder of timestamped captures
 * needs. Ties fall back to newest-first everywhere, so equal-sized or
 * identically-named captures still land in a stable, meaningful order.
 */
export function sortCaptures(
  items: CaptureMeta[],
  sort: LibrarySort
): CaptureMeta[] {
  const byNewest = (a: CaptureMeta, b: CaptureMeta) =>
    b.createdAtMs - a.createdAtMs;
  const copy = [...items];
  switch (sort) {
    case "newest":
      return copy.sort(byNewest);
    case "oldest":
      return copy.sort((a, b) => a.createdAtMs - b.createdAtMs);
    case "name":
      return copy.sort(
        (a, b) =>
          a.title.localeCompare(b.title, undefined, {
            numeric: true,
            sensitivity: "base",
          }) || byNewest(a, b)
      );
    case "largest":
      return copy.sort((a, b) => b.sizeBytes - a.sizeBytes || byNewest(a, b));
  }
}

/**
 * How many captures of each kind, for the sidebar's counts.
 *
 * Counted over whatever list the caller passes — which is the live
 * (non-trashed) set, not the raw listing, so the number beside "Videos"
 * is the number of rows clicking it would show. A count that included
 * trashed rows would send the user to a grid with fewer items than the
 * label promised.
 */
export function countKinds(items: CaptureMeta[]): Map<CaptureKind, number> {
  const counts = new Map<CaptureKind, number>();
  for (const m of items) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  return counts;
}

/** Every tag in use with how many captures carry it, ordered by the
 *  same case-insensitive name sort `allTags` uses. */
export function tagCounts(items: CaptureMeta[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const m of items) {
    for (const tag of m.tags ?? []) {
      const key = tag.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return allTags(items).map((tag) => ({
    tag,
    count: counts.get(tag.toLowerCase()) ?? 0,
  }));
}

/**
 * Does this capture carry `tag`? Case-insensitively, because the backend
 * preserves the spelling the user typed while treating `Bug` and `bug`
 * as one tag — a filter that compared exactly would show an empty grid
 * for a tag plainly visible on the cards.
 */
export function hasTag(meta: CaptureMeta, tag: string): boolean {
  const wanted = tag.trim().toLowerCase();
  if (!wanted) return false;
  return (meta.tags ?? []).some((t) => t.toLowerCase() === wanted);
}

/**
 * Every distinct tag across `items`, sorted case-insensitively — the
 * vocabulary behind the tag filter row and the editor's suggestions.
 *
 * Derived from the listing rather than fetched: every row already
 * carries its tags, so a "known tags" IPC would be a second source for
 * something the page is holding.
 */
export function allTags(items: CaptureMeta[]): string[] {
  const seen = new Map<string, string>();
  for (const m of items) {
    for (const tag of m.tags ?? []) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) seen.set(key, tag);
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
}

/**
 * The captures of `collection`, in its curated order.
 *
 * Members whose capture isn't in `items` are skipped — trashed while the
 * collection was open, or on a drive that isn't mounted. They are *not*
 * removed from the collection; that only happens on a purge, so a
 * temporarily-absent capture keeps its place.
 */
export function collectionItems(
  items: CaptureMeta[],
  collection: Collection
): CaptureMeta[] {
  const byId = new Map(items.map((m) => [m.id, m]));
  return collection.members
    .map((id) => byId.get(id))
    .filter((m): m is CaptureMeta => m !== undefined);
}

/**
 * Group a (pre-filtered) list by calendar day, newest day first.
 * Returns `[dayKey, items][]` where `dayKey` is local-midnight
 * epoch-ms. Items within a day preserve their incoming order
 * (the caller sorts newest-first before grouping).
 */
export function groupByDay(items: CaptureMeta[]): [number, CaptureMeta[]][] {
  const map = new Map<number, CaptureMeta[]>();
  for (const m of items) {
    const key = dayKey(m.createdAtMs);
    const arr = map.get(key);
    if (arr) arr.push(m);
    else map.set(key, [m]);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]);
}
