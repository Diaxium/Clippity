import { useCallback, useEffect, useMemo } from "react";

import {
  LayoutGrid,
  List,
  PanelRight,
  SquareCheckBig,
  SquareDashed,
} from "lucide-react";

import {
  libraryDelete,
  libraryPurge,
  libraryRestore,
} from "@services/tauri/clients/library";
import { openDashboard } from "@services/tauri/clients/dashboard";
import { emitErrorToast } from "@services/tauri/clients/toast";
import { useContextMenu, type ContextMenuEntry } from "@shared/ui/contextMenu";

import { useCollections } from "../hooks/useCollections";
import { useLibraryFacets } from "../hooks/useLibraryFacets";
import { useLibraryList } from "../hooks/useLibraryList";
import { useLibraryQuery } from "../hooks/useLibraryQuery";
import { useProgressiveRender } from "../hooks/useProgressiveRender";
import { useLibraryKeybinds, type LibraryKeybindApi } from "../keybinds";
import {
  collectionItems,
  filterCaptures,
  groupByDay,
  sortCaptures,
} from "../lib/grouping";
import { takeSections, type Section } from "../lib/paging";
import { dayLabel } from "../lib/format";
import { SMART_COLLECTIONS } from "../lib/smart";
import { openCapture } from "../lib/openCapture";
import { activeScope, useLibraryStore } from "../state/libraryStore";
import { KIND_TABS } from "../modes";
import type { CaptureMeta, LibraryQuery } from "../types";
import { DaySection } from "./DaySection";
import { EmptyState } from "./EmptyState";
import { Inspector } from "./Inspector";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryToolbar } from "./LibraryToolbar";
import { LibraryTopBar } from "./LibraryTopBar";
import { SelectionBar } from "./SelectionBar";

/**
 * Library page root — the dashboard window's `library` view.
 *
 * Three columns, each answering a different question. The **rail** on
 * the left answers *where am I* — every destination the grid can point
 * at, with a live count beside it. The **grid** in the middle answers
 * *what is here*. The **inspector** on the right answers *what is this
 * one*, which is the question the old single-column layout could only
 * answer with a hover tooltip.
 *
 * The panes are dropped by width rather than reflowed. Below ~64rem of
 * *container* (not viewport — the dashboard's own nav rail collapses
 * independently, and a viewport breakpoint would guess wrong every time
 * it did) the inspector goes; below ~46rem the destination rail follows
 * it, leaving the grid whole. Nothing is ever squeezed to a width where
 * it stops being readable.
 *
 * **The page never holds the library** (performance roadmap P5). Three
 * bounded reads replace what used to be one unbounded one:
 *
 * - the **grid** pages through `useLibraryQuery`, so the filters, search,
 *   sort and pagination run as SQL and only a page's rows cross IPC;
 * - the **rail** reads `useLibraryFacets` — aggregate counts over the
 *   whole library, which no page could answer and which would otherwise
 *   force the very listing load paging removes;
 * - the **DOM** is bounded again on top of that (`useProgressiveRender` +
 *   `takeSections`), because mounting a card costs more than fetching its
 *   row, and the two grow together as the user scrolls.
 *
 * Two scopes opt out and read the full listing, because neither is a
 * `WHERE` clause: a **smart collection** is a rule over every row, and a
 * **collection** is a curated id list whose order is the content. See
 * `needsFullList` — it is the one place the two paths are chosen between,
 * and everything below it is written against `rows` so the rest of the
 * component doesn't know which it got.
 *
 * One consequence worth knowing: on the paged path "Select all" selects
 * the rows *loaded so far*, not every row the scope matches — the ids of
 * unloaded rows aren't known to the client. `count` still reports the
 * scope's true size, so the toolbar never reads as how far you scrolled.
 *
 * Delete / restore / purge fire their IPC and rely on the backend's
 * `clippity://library/updated` emit to refresh — every hook here
 * subscribes to it. Errors surface as toasts.
 */
export function LibraryLayout() {
  const mode = useLibraryStore((s) => s.mode);
  const view = useLibraryStore((s) => s.view);
  const setView = useLibraryStore((s) => s.setView);
  const kindFilter = useLibraryStore((s) => s.kindFilter);
  const favoritesOnly = useLibraryStore((s) => s.favoritesOnly);
  const tagFilter = useLibraryStore((s) => s.tagFilter);
  const setTagFilter = useLibraryStore((s) => s.setTagFilter);
  const collectionId = useLibraryStore((s) => s.collectionId);
  const smart = useLibraryStore((s) => s.smart);
  const search = useLibraryStore((s) => s.search);
  const setSearch = useLibraryStore((s) => s.setSearch);
  const sort = useLibraryStore((s) => s.sort);
  const setSort = useLibraryStore((s) => s.setSort);
  const setScope = useLibraryStore((s) => s.setScope);
  const focusedId = useLibraryStore((s) => s.focusedId);
  const setFocused = useLibraryStore((s) => s.setFocused);
  const inspectorOpen = useLibraryStore((s) => s.inspectorOpen);
  const toggleInspector = useLibraryStore((s) => s.toggleInspector);
  const selected = useLibraryStore((s) => s.selected);
  const clearSelection = useLibraryStore((s) => s.clearSelection);
  const selectAll = useLibraryStore((s) => s.selectAll);
  const setVisibleIds = useLibraryStore((s) => s.setVisibleIds);

  const { collections } = useCollections();
  const { facets } = useLibraryFacets();

  const scope = activeScope({
    mode,
    kindFilter,
    favoritesOnly,
    collectionId,
    smart,
  });
  const activeCollection =
    collections.find((c) => c.id === collectionId) ?? null;

  /**
   * Which of the two reads this scope needs.
   *
   * Almost every destination is a `WHERE` clause, so the grid pages
   * through SQL and never holds the library. The two that aren't: a
   * **smart collection** is a rule evaluated against every row, and a
   * **collection** is a curated id list whose order *is* the content —
   * neither survives being cut into pages. Those two fall back to the
   * full listing, which is what the whole page used to do.
   */
  const needsFullList = smart !== null || collectionId !== null;

  const { items: allItems, loading: listLoading } = useLibraryList(
    true,
    needsFullList
  );

  // The page's narrowing, pushed into SQL. `trash` is a tri-state rather
  // than a superset flag because the trash view is the deleted half
  // *only* — a page has no other rows to filter down from.
  const query = useMemo<LibraryQuery>(
    () => ({
      trash: mode === "trash" ? "only" : "exclude",
      kind: kindFilter === "all" ? undefined : kindFilter,
      favoritesOnly: favoritesOnly || undefined,
      tag: tagFilter ?? undefined,
      search: search.trim() || undefined,
      sort,
    }),
    [mode, kindFilter, favoritesOnly, tagFilter, search, sort]
  );

  const {
    items: pageItems,
    total: pageTotal,
    loading: pageLoading,
    hasMore: hasMorePages,
    loadMore,
  } = useLibraryQuery(query, undefined, !needsFullList);

  const loading = needsFullList ? listLoading : pageLoading;

  // The rows the grid is showing, however they were obtained. On the
  // paged path SQL has already applied the filters; on the full-list
  // path `filterCaptures` still does, because that is where the smart
  // rule and the trash/live split live.
  const rows = useMemo(
    () =>
      needsFullList
        ? filterCaptures(allItems, {
            mode,
            kindFilter,
            favoritesOnly,
            tagFilter,
            smart,
            search,
          })
        : pageItems,
    [
      needsFullList,
      allItems,
      pageItems,
      mode,
      kindFilter,
      favoritesOnly,
      tagFilter,
      smart,
      search,
    ]
  );

  /**
   * How the grid is carved up.
   *
   * A collection keeps its own order and renders as one unheaded run:
   * the curated arrangement *is* the content, and re-sorting or
   * date-grouping it would destroy the thing the user built. Everything
   * else groups by day under a chronological sort — recency is how you
   * find a capture you just took — and collapses to a single flat run
   * under any other, because "Today / Yesterday" headings over a
   * largest-first list would be a lie about the order.
   */
  const sections = useMemo((): Section[] => {
    if (activeCollection) {
      const members = collectionItems(rows, activeCollection);
      return members.length === 0
        ? []
        : [{ key: activeCollection.id, heading: null, items: members }];
    }
    // The paged path arrives already ordered by SQL; re-sorting it would
    // only reorder *within* the loaded prefix and fight the next page.
    const sorted = needsFullList ? sortCaptures(rows, sort) : rows;
    if (sort !== "newest" && sort !== "oldest") {
      return sorted.length === 0
        ? []
        : [{ key: "all", heading: null, items: sorted }];
    }
    const days = groupByDay(sorted);
    if (sort === "oldest") days.reverse();
    return days.map(([key, dayItems]) => ({
      key: String(key),
      heading: dayLabel(key),
      items: dayItems,
    }));
  }, [rows, needsFullList, activeCollection, sort]);

  const visible = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // The tag vocabulary is a property of the whole library, not of the
  // rows on screen, so it comes from the same aggregate the rail reads.
  const suggestions = useMemo(
    () => facets.tags.map((t) => t.tag),
    [facets.tags]
  );

  /**
   * How many captures this scope holds in total.
   *
   * On the paged path that is the backend's match count, *not*
   * `visible.length` — the grid deliberately holds only a prefix, and a
   * toolbar reading "100 captures" over a library of 12,000 would be
   * reporting how far the user has scrolled.
   */
  const count = needsFullList ? visible.length : pageTotal;

  // What is *mounted*. Keyed by the identity of the list on screen, so
  // changing scope, sort, search or any filter starts the budget over at
  // the top — the rows scrolled past belong to a list the user has left.
  const renderKey = `${mode}|${kindFilter}|${favoritesOnly}|${tagFilter ?? ""}|${
    smart ?? ""
  }|${collectionId ?? ""}|${search}|${sort}`;
  const {
    count: renderCount,
    hasMore: hasMoreToRender,
    sentinelRef,
  } = useProgressiveRender(visible.length, renderKey);
  const renderedSections = useMemo(
    () => takeSections(sections, renderCount),
    [sections, renderCount]
  );

  // Two bounded things, chained: the render budget grows until it has
  // mounted every loaded row, and *that* is what asks for the next page.
  // So scrolling pulls rows through the backend at the rate they are
  // actually looked at, and a library that is never scrolled costs one
  // page.
  useEffect(() => {
    if (!needsFullList && !hasMoreToRender && hasMorePages) loadMore();
  }, [needsFullList, hasMoreToRender, hasMorePages, loadMore]);

  // The sentinel is what the *user* can reach: more to mount, or more to
  // fetch and then mount.
  const hasMoreBelow = hasMoreToRender || (!needsFullList && hasMorePages);

  // Mirror the render order into the store so a Shift-click range and
  // Ctrl+A can resolve "what is on screen, in what order" without the
  // list being drilled through DaySection → Grid → Card. This component
  // is the only one that knows it: `sections` is where the day grouping,
  // the sort and a collection's curated order are finally reconciled.
  const visibleIds = useMemo(() => visible.map((m) => m.id), [visible]);
  useEffect(() => setVisibleIds(visibleIds), [visibleIds, setVisibleIds]);

  // Resolved from the visible list rather than held as an object, so a
  // capture that was trashed, renamed, or filtered out from under the
  // inspector simply closes it instead of leaving a stale panel
  // describing something no longer on screen.
  const focused = useMemo(
    () => visible.find((m) => m.id === focusedId) ?? null,
    [visible, focusedId]
  );

  const scopeLabel = useMemo(() => {
    switch (scope.kind) {
      case "trash":
        return "Trash";
      case "favorites":
        return "Favorites";
      case "collection":
        return activeCollection?.name ?? "Collection";
      case "smart":
        return (
          SMART_COLLECTIONS.find((s) => s.id === scope.id)?.label ?? "Smart"
        );
      case "kind":
        return KIND_TABS.find((t) => t.id === scope.value)?.label ?? "Captures";
      default:
        return "All captures";
    }
  }, [scope, activeCollection]);

  /**
   * Open a capture for real — the destination half of "open".
   *
   * Palette entries open the main window's large palette view; every
   * other file-backed capture goes to whichever surface `openCapture`
   * routes it to, which is a recording's Studio or a still's editor. The
   * remaining two kinds never reach here: a color and a text run have no
   * view worth opening, so *their* open is a clipboard write, which the
   * card and row perform themselves because only they can show that it
   * happened (see `CaptureCard`). The guard stays anyway — a future
   * caller that doesn't know that must not fall through with an id that
   * has no file behind it.
   *
   * The routing is deferred rather than decided here on purpose: this
   * handler used to send *everything* to the editor, which is how a
   * recording came to be opened as an image long after the context menu
   * and Inspector had learned better.
   */
  const onOpen = useCallback((m: CaptureMeta) => {
    if (m.kind === "palette") {
      void openDashboard("palette", m.id);
      return;
    }
    if (m.kind === "color" || m.kind === "text") return;
    openCapture(m);
  }, []);

  const onFocus = useCallback(
    (m: CaptureMeta) => setFocused(m.id),
    [setFocused]
  );

  /**
   * Run a per-file op over a set of ids.
   *
   * Unlike labels and collection membership — one call over a whole
   * selection — trash / restore / purge are per-file moves with per-file
   * failure modes, so they fan out. `allSettled`, not `all`: one capture
   * that another window already moved must not abort the rest, and the
   * user gets one toast rather than a cascade.
   */
  const runBulk = useCallback(
    async (
      ids: string[],
      op: (id: string) => Promise<unknown>,
      failure: string
    ) => {
      const results = await Promise.allSettled(ids.map(op));
      clearSelection();
      if (focusedId && ids.includes(focusedId)) setFocused(null);
      const failures = results.filter((r) => r.status === "rejected").length;
      if (failures > 0) {
        void emitErrorToast(
          ids.length === 1
            ? failure
            : `${failure} (${failures} of ${ids.length} failed)`
        );
      }
    },
    [clearSelection, focusedId, setFocused]
  );

  const onTrash = useCallback(
    (ids: string[]) =>
      void runBulk(ids, libraryDelete, "Failed to delete capture."),
    [runBulk]
  );
  const onRestoreMany = useCallback(
    (ids: string[]) =>
      void runBulk(ids, libraryRestore, "Failed to restore capture."),
    [runBulk]
  );
  const onPurgeMany = useCallback(
    (ids: string[]) =>
      void runBulk(ids, libraryPurge, "Failed to delete capture."),
    [runBulk]
  );

  const onDeleteOne = useCallback(
    (m: CaptureMeta) => onTrash([m.id]),
    [onTrash]
  );
  const onRestoreOne = useCallback(
    (m: CaptureMeta) => onRestoreMany([m.id]),
    [onRestoreMany]
  );
  const onPurgeOne = useCallback(
    (m: CaptureMeta) => onPurgeMany([m.id]),
    [onPurgeMany]
  );

  /**
   * The Delete key's target.
   *
   * **Both** the guard and the selection are read from `getState()`, not
   * from the subscribed values. Mixing the two is the bug that hides
   * here: a closed-over `mode` only updates on re-render, so between the
   * scope change and React's next commit the guard would still say
   * "library" while the ids it acts on are already fresh — and the one
   * thing this guard protects is the mode where deletion is
   * irreversible. Reading both from the same snapshot makes that window
   * impossible.
   *
   * Keeping the api free of subscribed values also keeps the object
   * stable, so the keybind listener isn't re-attached on every click.
   *
   * Inert in Trash mode on purpose — the only delete left there is
   * `purge`, which has no undo. See the binding's note.
   */
  const trashSelection = useCallback(() => {
    const live = useLibraryStore.getState();
    if (live.mode === "trash") return;
    if (live.selected.length > 0) onTrash(live.selected);
  }, [onTrash]);

  const keybindApi = useMemo<LibraryKeybindApi>(
    () => ({ trashSelection }),
    [trashSelection]
  );
  useLibraryKeybinds(true, keybindApi);

  // "Select all" means every capture the current scope + filters are
  // showing, not everything on disk — the grid is what the user can see
  // and what a bulk action would visibly act on.
  const onBackgroundContextMenu = useContextMenu(
    useCallback(
      (): ContextMenuEntry[] => [
        {
          id: "select-all",
          label: "Select all",
          shortcut: "Ctrl A",
          icon: SquareCheckBig,
          disabled: visible.length === 0,
          onSelect: selectAll,
        },
        {
          id: "clear-selection",
          label: "Clear selection",
          icon: SquareDashed,
          disabled: selected.length === 0,
          onSelect: clearSelection,
        },
        "divider",
        {
          id: "view",
          label: view === "grid" ? "Show as list" : "Show as grid",
          icon: view === "grid" ? List : LayoutGrid,
          onSelect: () => setView(view === "grid" ? "list" : "grid"),
        },
        {
          id: "inspector",
          label: inspectorOpen ? "Hide details" : "Show details",
          icon: PanelRight,
          onSelect: toggleInspector,
        },
      ],
      [
        visible.length,
        selected.length,
        view,
        inspectorOpen,
        selectAll,
        clearSelection,
        setView,
        toggleInspector,
      ]
    ),
    "Library actions"
  );

  return (
    <div className="@container flex h-full flex-col overflow-hidden">
      <LibraryTopBar
        heading={mode === "trash" ? "Trash" : "Library"}
        search={search}
        onSearch={setSearch}
      />

      <div className="flex min-h-0 flex-1 border-t border-[color:var(--hairline)]">
        <LibrarySidebar
          facets={facets}
          collections={collections}
          scope={scope}
          onScope={setScope}
          tagFilter={tagFilter}
          onTagFilter={setTagFilter}
          className="hidden @min-[46rem]:flex"
        />

        <div className="flex min-w-0 flex-1 flex-col pt-3">
          <LibraryToolbar
            scopeLabel={scopeLabel}
            count={count}
            loading={loading}
            sort={sort}
            onSort={setSort}
            view={view}
            onView={setView}
            search={search}
            onClearSearch={() => setSearch("")}
            tagFilter={tagFilter}
            onClearTag={() => setTagFilter(null)}
            inspectorOpen={inspectorOpen}
            onToggleInspector={toggleInspector}
          />

          {/* Right-clicking the gutter between cards is a click on the
              *list*, not on any capture — so it offers what applies to the
              list. A card's own menu stops propagation before this sees
              the event, so the two never compete. */}
          <div
            className="flex-1 overflow-auto px-6 pb-6"
            onContextMenu={onBackgroundContextMenu}
          >
            {sections.length === 0 ? (
              <EmptyState
                context={{
                  mode,
                  kindFilter,
                  favoritesOnly,
                  tagFilter,
                  search,
                  smartLabel: smart
                    ? (SMART_COLLECTIONS.find((s) => s.id === smart)?.label ??
                      null)
                    : null,
                  collectionName: activeCollection?.name ?? null,
                }}
                loading={loading}
              />
            ) : (
              <>
                {renderedSections.map((section) => (
                  <DaySection
                    key={section.key}
                    heading={section.heading}
                    items={section.items}
                    view={view}
                    mode={mode}
                    onFocus={onFocus}
                    onOpen={onOpen}
                    onDelete={onDeleteOne}
                    onRestore={onRestoreOne}
                    onPurge={onPurgeOne}
                  />
                ))}
                {/* Crossing this mounts the next batch — and, once every
                    loaded row is mounted, fetches the next page. It sits
                    after the last rendered card and is removed when there
                    is nothing left below, so there is nothing to trip. */}
                {hasMoreBelow && (
                  <div ref={sentinelRef} aria-hidden className="h-px w-full" />
                )}
              </>
            )}

            <SelectionBar
              selected={selected}
              items={visible}
              mode={mode}
              collections={collections}
              activeCollectionId={collectionId}
              suggestions={suggestions}
              onTrash={onTrash}
              onRestore={onRestoreMany}
              onPurge={onPurgeMany}
            />
          </div>
        </div>

        {inspectorOpen && focused && (
          <Inspector
            meta={focused}
            mode={mode}
            collections={collections}
            suggestions={suggestions}
            onDelete={onDeleteOne}
            onRestore={onRestoreOne}
            onPurge={onPurgeOne}
            onClose={() => setFocused(null)}
            className="hidden @min-[64rem]:flex"
          />
        )}
      </div>
    </div>
  );
}
