import { useCallback, useEffect, useState } from "react";

import {
  libraryList,
  onLibraryUpdated,
  type CaptureMeta,
} from "@services/tauri/clients/library";
import { emitErrorToast } from "@services/tauri/clients/toast";

interface UseLibraryListResult {
  items: CaptureMeta[];
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Owns the library's items list + loading flag. Fetches on mount and
 * whenever `includeTrashed` changes, and subscribes to
 * `clippity://library/updated` so a new capture (or a delete /
 * restore / purge from anywhere) refreshes the list automatically.
 *
 * Errors surface as an error toast (the toast port landed before
 * library) and leave the list empty rather than throwing — the page
 * renders its empty-state instead of crashing.
 *
 * `enabled` exists because loading the whole library is now the
 * exception rather than the rule: the grid reads pages through
 * `useLibraryQuery`, and only the two scopes a query cannot express (a
 * smart collection's rule, a collection's curated membership) still need
 * every row. Passing `false` holds the fetch entirely — a disabled list
 * is empty and not loading, never a stale set of rows from the last time
 * it ran.
 */
export function useLibraryList(
  includeTrashed: boolean,
  enabled: boolean = true
): UseLibraryListResult {
  const [items, setItems] = useState<CaptureMeta[]>([]);
  const [loading, setLoading] = useState(enabled);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await libraryList(includeTrashed);
      setItems(next ?? []);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load the library.";
      void emitErrorToast(message);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [includeTrashed, enabled]);

  // Initial fetch + refetch when the trashed scope changes.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Event-driven refresh — a capture landing or a trash op anywhere
  // fires `library/updated`.
  useEffect(() => {
    return onLibraryUpdated(() => void refresh());
  }, [refresh]);

  return { items, loading, refresh };
}
