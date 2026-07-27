import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  libraryQuery,
  onLibraryUpdated,
  type CaptureMeta,
  type LibraryQuery,
} from "@services/tauri/clients/library";
import { emitErrorToast } from "@services/tauri/clients/toast";

/** Rows per page fetch. Big enough that a first screen rarely needs a
 *  second round-trip, small enough that the backend materializes a page
 *  in single-digit milliseconds even at 50k rows (bench `page_50`). */
export const DEFAULT_PAGE_SIZE = 100;

export interface UseLibraryQueryResult {
  /** Rows loaded so far — the first page, plus every `loadMore`. */
  items: CaptureMeta[];
  /** Rows the filters match in total (before pagination) — for the
   *  scrollbar and the "N captures" count. */
  total: number;
  /** A fetch is in flight (first page or a `loadMore`). */
  loading: boolean;
  /** More rows exist beyond what's loaded. */
  hasMore: boolean;
  /** Fetch and append the next page. No-op while a fetch is in flight or
   *  everything is already loaded. */
  loadMore: () => void;
  /** Discard and reload from the first page. */
  refresh: () => void;
}

/**
 * Paged, filtered library data for a virtualized grid (performance
 * roadmap P5). Owns pagination over {@link libraryQuery}: the first page
 * loads on mount and whenever the filter set changes, `loadMore` appends
 * the next, and a `clippity://library/updated` event reloads from the
 * top.
 *
 * The `query`'s `limit`/`offset` are managed here and ignored if passed.
 * Changing any *filter* field (kind, search, sort, tag, …) restarts
 * pagination; the filter set is compared by value, so a caller passing a
 * fresh object each render doesn't thrash.
 *
 * Errors surface as a toast and leave the loaded rows in place (a failed
 * `loadMore`) or empty (a failed first page), mirroring `useLibraryList`.
 *
 * `enabled: false` holds every fetch and reports an empty, not-loading
 * list — for the scopes a query cannot express (a smart collection's
 * rule, a collection's curated order), where the caller reads the full
 * listing instead.
 */
export function useLibraryQuery(
  query: LibraryQuery,
  pageSize: number = DEFAULT_PAGE_SIZE,
  enabled: boolean = true,
): UseLibraryQueryResult {
  const [items, setItems] = useState<CaptureMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(enabled);

  // The filters, without the pagination this hook owns — its value is the
  // identity that, when it changes, restarts the list.
  const { limit: _limit, offset: _offset, ...filters } = query;
  const key = JSON.stringify(filters);

  // Read the latest filters inside async callbacks without making those
  // callbacks change identity every render (`filters` is a fresh object
  // each time). `key` is the real dependency.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // A generation counter fences stale responses: a slow page for an old
  // filter set (or before a refresh) must not land on the new list.
  const genRef = useRef(0);
  const inFlightRef = useRef(false);
  const loadedRef = useRef(0);
  const totalRef = useRef(0);

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      if (!enabled) {
        setItems([]);
        setTotal(0);
        loadedRef.current = 0;
        totalRef.current = 0;
        setLoading(false);
        return;
      }
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const gen = genRef.current;
      setLoading(true);
      try {
        const page = await libraryQuery({
          ...filtersRef.current,
          limit: pageSize,
          offset,
        });
        if (gen !== genRef.current) return; // superseded — drop it
        totalRef.current = page.total;
        setTotal(page.total);
        setItems((prev) => {
          const next = replace ? page.items : [...prev, ...page.items];
          loadedRef.current = next.length;
          return next;
        });
      } catch (err) {
        if (gen !== genRef.current) return;
        const message =
          err instanceof Error ? err.message : "Failed to load the library.";
        void emitErrorToast(message);
        if (replace) {
          loadedRef.current = 0;
          totalRef.current = 0;
          setItems([]);
          setTotal(0);
        }
      } finally {
        if (gen === genRef.current) setLoading(false);
        inFlightRef.current = false;
      }
    },
    [pageSize, enabled],
  );

  // Bump the generation and reload from the top — the shared restart used
  // by a filter change, a refresh() and a library/updated event.
  const restart = useCallback(() => {
    genRef.current += 1;
    inFlightRef.current = false;
    loadedRef.current = 0;
    void fetchPage(0, true);
  }, [fetchPage]);

  // First page on mount, and again whenever the filter set changes.
  // `key` is the value-identity of the filters `restart` reads via ref —
  // it isn't referenced in the body, it *is* the trigger.
  useEffect(() => {
    restart();
  }, [key, restart]);

  // A capture landing (or a delete / restore / purge anywhere) reloads.
  useEffect(() => onLibraryUpdated(restart), [restart]);

  const loadMore = useCallback(() => {
    if (inFlightRef.current) return;
    if (loadedRef.current >= totalRef.current) return;
    void fetchPage(loadedRef.current, false);
  }, [fetchPage]);

  const hasMore = items.length < total;

  return useMemo(
    () => ({ items, total, loading, hasMore, loadMore, refresh: restart }),
    [items, total, loading, hasMore, loadMore, restart],
  );
}
