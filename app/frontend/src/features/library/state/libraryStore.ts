/**
 * Library-view UI state.
 *
 * Feature-local Zustand slice for every view dimension the page has:
 * the mode / kind filter / grid-or-list it started with, plus the
 * catalog-v2 refinements (favorites, a tag, a collection) and the
 * multi-select buffer. The items list + loading flag are NOT here — they
 * live in `useLibraryList`'s local state, since only `LibraryLayout`
 * consumes them and there's no cross-component sharing.
 *
 * The slice exists because these ARE read by multiple components
 * (header, tabs, rail, cards, the selection bar) and prop-drilling them
 * through the day-grouped tree would be noise. Selection in particular:
 * a card needs to know whether it is selected, and drilling that through
 * DaySection → Grid → Card would thread a prop through two components
 * that have no interest in it.
 */

import { create } from "zustand";

import type {
  KindTab,
  LibraryMode,
  LibraryScope,
  LibrarySort,
  LibraryView,
  SmartId,
} from "../types";

interface LibraryStoreState {
  mode: LibraryMode;
  kindFilter: KindTab;
  view: LibraryView;
  /** Show only starred captures. */
  favoritesOnly: boolean;
  /** Show only captures carrying this tag (case-insensitive), or all. */
  tagFilter: string | null;
  /** Show one collection's members, in its curated order, instead of the
   *  date-grouped library. `null` is the whole library. */
  collectionId: string | null;
  /** Active smart collection (a rule over the listing), or `null`. */
  smart: SmartId | null;
  /** Search-box query. Not part of the scope — it narrows whatever
   *  destination is open, and survives switching between them. */
  search: string;
  /** Grid ordering. */
  sort: LibrarySort;
  /** The capture the inspector is showing — the *focus*, which is a
   *  different thing from the selection: focusing is "let me look at
   *  this one", selecting is "these are the ones I'm about to act on". */
  focusedId: string | null;
  /** Whether the inspector pane is shown at all (it also needs the room
   *  — see the layout's container query). */
  inspectorOpen: boolean;
  /** Multi-selected capture ids, **in click order** — "add to
   *  collection" appends them the way the user picked them, which a Set
   *  could not promise. */
  selected: string[];
  /** The pivot a Shift-click ranges from: the last capture the user
   *  pointed at, by *either* gesture (a plain click that only focused, or
   *  a Ctrl-click that selected). Held separately from `focusedId`
   *  because Ctrl-click deliberately doesn't move the inspector, yet must
   *  still move the pivot — otherwise the second half of
   *  "Ctrl-click one, Shift-click another" ranges from whatever the
   *  inspector happens to be showing. */
  anchorId: string | null;
  /** Every capture currently on screen, in render order, flattened across
   *  day sections. A range select and "select all" are both statements
   *  about *what is on screen*, and the only component that knows that is
   *  `LibraryLayout` — which mirrors its render order here so a card can
   *  resolve a range without the order being drilled through
   *  DaySection → Grid → Card. */
  visibleIds: string[];

  setMode(m: LibraryMode): void;
  setKindFilter(k: KindTab): void;
  setView(v: LibraryView): void;
  toggleFavoritesOnly(): void;
  setTagFilter(tag: string | null): void;
  setCollectionId(id: string | null): void;
  setScope(scope: LibraryScope): void;
  setSearch(q: string): void;
  setSort(s: LibrarySort): void;
  setFocused(id: string | null): void;
  toggleInspector(): void;
  toggleSelected(id: string): void;
  setSelected(ids: string[]): void;
  clearSelection(): void;
  setVisibleIds(ids: string[]): void;
  /** Select the run between the anchor and `id`. `additive` keeps what was
   *  already selected (Ctrl+Shift-click) instead of replacing it. */
  selectRange(id: string, additive: boolean): void;
  /** Select everything currently on screen. */
  selectAll(): void;
}

/** Every refinement, back to "show me everything". */
const CLEARED = {
  kindFilter: "all" as KindTab,
  favoritesOnly: false,
  tagFilter: null,
  collectionId: null,
  smart: null,
  focusedId: null,
  selected: [] as string[],
  anchorId: null,
};

export const useLibraryStore = create<LibraryStoreState>((set) => ({
  mode: "library",
  view: "grid",
  search: "",
  sort: "newest",
  inspectorOpen: true,
  visibleIds: [],
  ...CLEARED,

  // Mode is a context switch (Library ↔ Trash), not a refinement — a
  // filter left over from the other context silently hides rows
  // ("Trash · 0 captures" while items sit behind a stale Videos tab), so
  // entering a mode clears every refinement. The selection goes with
  // them: it names captures from a list that is no longer on screen.
  setMode: (mode) => set({ mode, ...CLEARED }),
  setKindFilter: (kindFilter) => set({ kindFilter }),
  setView: (view) => set({ view }),
  toggleFavoritesOnly: () => set((s) => ({ favoritesOnly: !s.favoritesOnly })),
  setTagFilter: (tagFilter) => set({ tagFilter }),
  // Opening a collection changes which captures are on screen, so a
  // selection made against the previous list would act on rows the user
  // can no longer see.
  setCollectionId: (collectionId) =>
    set({ collectionId, selected: [], focusedId: null, anchorId: null }),

  // One sidebar click, one coherent destination: every other scope
  // dimension is reset in the same update. Setting them individually
  // would let "Videos" and "Trash" both look active, and the grid would
  // then be showing something neither row promises.
  //
  // The tag filter goes too — it is a refinement *of a scope*, and a tag
  // that had matches in the collection you just left may have none where
  // you landed, so carrying it over lands the user on an empty grid with
  // no obvious cause. `search` deliberately survives: the box is visibly
  // still full, so its effect is never a mystery.
  setScope: (scope) =>
    set({
      mode: scope.kind === "trash" ? "trash" : "library",
      kindFilter: scope.kind === "kind" ? scope.value : "all",
      favoritesOnly: scope.kind === "favorites",
      collectionId: scope.kind === "collection" ? scope.id : null,
      smart: scope.kind === "smart" ? scope.id : null,
      tagFilter: null,
      focusedId: null,
      selected: [],
      anchorId: null,
    }),

  setSearch: (search) => set({ search }),
  setSort: (sort) => set({ sort }),
  // Focusing moves the range pivot: a plain click is the gesture that
  // says "start here", and it would be a strange rule that only a
  // Ctrl-click could set the anchor. Clearing the focus (closing the
  // inspector) leaves the anchor alone — the selection it belongs to is
  // still on screen.
  setFocused: (focusedId) =>
    set(
      focusedId === null ? { focusedId } : { focusedId, anchorId: focusedId }
    ),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  toggleSelected: (id) =>
    set((s) => ({
      selected: s.selected.includes(id)
        ? s.selected.filter((x) => x !== id)
        : [...s.selected, id],
      anchorId: id,
    })),
  setSelected: (selected) => set({ selected }),
  clearSelection: () => set({ selected: [], anchorId: null }),
  setVisibleIds: (visibleIds) => set({ visibleIds }),

  /**
   * Shift-click: select the contiguous run between the anchor and `id`.
   *
   * The pivot falls back to `focusedId` when no anchor has been set,
   * which is what makes the gesture work from a cold start: a plain click
   * only focuses — it deliberately does not select — so without the
   * fallback the very first "click one, Shift-click another" would have
   * nothing to range from and would select a single capture, which is
   * exactly the case the feature exists for.
   *
   * The run is stored in **screen order**, not anchor-outward order. The
   * selection list is ordered because "add to collection" appends in it,
   * and a user who Shift-clicked *upward* was pointing at a block, not
   * asking for it reversed — the block's own order is the grid's.
   *
   * The pivot is then pinned as the anchor so successive Shift-clicks
   * re-range from the same place (widening and narrowing the run) instead
   * of walking the anchor along behind the cursor.
   */
  selectRange: (id, additive) =>
    set((s) => {
      const order = s.visibleIds;
      const to = order.indexOf(id);
      if (to < 0) return {}; // not on screen: nothing to range over
      const pivot = s.anchorId ?? s.focusedId;
      const from = pivot === null ? -1 : order.indexOf(pivot);
      // No usable pivot (first gesture, or the anchor was filtered away):
      // this click becomes the anchor and selects just itself.
      if (from < 0) {
        const base = additive ? s.selected.filter((x) => x !== id) : [];
        return { selected: [...base, id], anchorId: id };
      }
      const lo = Math.min(from, to);
      const run = order.slice(lo, Math.max(from, to) + 1);
      return {
        selected: additive
          ? [...s.selected, ...run.filter((x) => !s.selected.includes(x))]
          : run,
        anchorId: order[from],
      };
    }),

  selectAll: () => set((s) => ({ selected: [...s.visibleIds] })),
}));

/**
 * Which sidebar destination the current state adds up to.
 *
 * The scope is stored as the five fields the filter pipeline actually
 * reads rather than as a `LibraryScope` value, because those fields have
 * their own setters (a tag chip on a card, the collection rail) that
 * predate the sidebar. This collapses them back into the one answer the
 * sidebar needs — "which row is lit" — in the order the rows are
 * offered, so a state that somehow set two of them still resolves to
 * exactly one highlighted row rather than none or both.
 */
export function activeScope(s: {
  mode: LibraryMode;
  kindFilter: KindTab;
  favoritesOnly: boolean;
  collectionId: string | null;
  smart: SmartId | null;
}): LibraryScope {
  if (s.mode === "trash") return { kind: "trash" };
  if (s.collectionId) return { kind: "collection", id: s.collectionId };
  if (s.smart) return { kind: "smart", id: s.smart };
  if (s.favoritesOnly) return { kind: "favorites" };
  if (s.kindFilter !== "all") return { kind: "kind", value: s.kindFilter };
  return { kind: "all" };
}

/** Do two scopes point at the same destination? */
export function sameScope(a: LibraryScope, b: LibraryScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "kind" && b.kind === "kind") return a.value === b.value;
  if (a.kind === "collection" && b.kind === "collection") return a.id === b.id;
  if (a.kind === "smart" && b.kind === "smart") return a.id === b.id;
  return true;
}

export type { LibraryStoreState };
