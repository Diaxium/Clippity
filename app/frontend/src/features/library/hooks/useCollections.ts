import { useCallback, useEffect, useState } from "react";

import {
  collectionsList,
  onCollectionsUpdated,
  type Collection,
} from "@services/tauri/clients/collections";
import { emitErrorToast } from "@services/tauri/clients/toast";

interface UseCollectionsResult {
  collections: Collection[];
  refresh: () => Promise<void>;
}

/**
 * Owns the collections list. Fetches on mount and re-fetches on
 * `clippity://collections/updated`, so a collection created in one
 * window appears in another without polling.
 *
 * Deliberately a separate subscription from `useLibraryList`'s: adding a
 * capture to a collection changes no row in a listing, and sharing one
 * event would make the whole grid re-fetch over an arrangement it isn't
 * showing.
 *
 * A failed fetch surfaces as a toast and leaves the list empty — the
 * rail renders as "no collections yet" rather than taking the page down,
 * matching how `useLibraryList` treats a failed listing.
 */
export function useCollections(): UseCollectionsResult {
  const [collections, setCollections] = useState<Collection[]>([]);

  const refresh = useCallback(async () => {
    try {
      setCollections((await collectionsList()) ?? []);
    } catch (err) {
      void emitErrorToast(
        err instanceof Error ? err.message : "Failed to load collections."
      );
      setCollections([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => onCollectionsUpdated(() => void refresh()), [refresh]);

  return { collections, refresh };
}
