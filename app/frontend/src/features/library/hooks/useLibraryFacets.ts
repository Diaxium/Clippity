import { useCallback, useEffect, useState } from "react";

import {
  libraryFacets,
  onLibraryUpdated,
  type LibraryFacets,
} from "@services/tauri/clients/library";
import { emitErrorToast } from "@services/tauri/clients/toast";

import { smartThresholds } from "../lib/smart";

/** What the rail shows before the first answer arrives: a complete set of
 *  zeroes rather than `null`, so every row renders at its resting size and
 *  the sidebar doesn't reflow when the counts land. */
const EMPTY: LibraryFacets = {
  total: 0,
  kinds: {},
  favorites: 0,
  trashed: 0,
  tags: [],
  smart: { thisWeek: 0, last30Days: 0, large: 0, untagged: 0 },
};

export interface UseLibraryFacetsResult {
  facets: LibraryFacets;
  refresh: () => Promise<void>;
}

/**
 * Whole-library counts for the destination rail (performance roadmap P5).
 *
 * The rail asks a question a page cannot answer — "how big is every scope,
 * including the ones you are not showing" — so it has its own aggregate
 * call rather than counting the rows the grid happens to hold. That split
 * is the whole point: with it, neither half of the library page needs the
 * full listing in memory.
 *
 * The smart-collection boundaries are computed here, per fetch, from
 * {@link smartThresholds}. "This week" is anchored to local midnight, so
 * the value is only correct for the moment it is read — recomputing it on
 * every refresh (rather than pinning it at mount) means a window left open
 * across midnight re-cuts its buckets on the next capture instead of
 * quietly ageing.
 *
 * Refreshes on `clippity://library/updated`, like `useLibraryList` — a
 * capture landing, a star, a tag or a trash op all move these numbers.
 * A failure toasts and leaves the previous counts up: a rail that keeps
 * showing slightly stale numbers is better than one that blanks to zero
 * while the grid beside it is full.
 */
export function useLibraryFacets(): UseLibraryFacetsResult {
  const [facets, setFacets] = useState<LibraryFacets>(EMPTY);

  const refresh = useCallback(async () => {
    try {
      // `?? EMPTY` for the same reason `useLibraryList` has `?? []`: a
      // rail is chrome, and a malformed answer should leave it reading
      // zero rather than take the page down with it.
      setFacets((await libraryFacets(smartThresholds())) ?? EMPTY);
    } catch (err) {
      void emitErrorToast(
        err instanceof Error ? err.message : "Failed to load library counts."
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onLibraryUpdated(() => void refresh()), [refresh]);

  return { facets, refresh };
}
