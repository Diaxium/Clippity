import { useEffect, useState } from "react";

import {
  libraryList,
  onLibraryUpdated,
  type CaptureMeta,
} from "@services/tauri/clients/library";

interface UsePaletteEntryResult {
  entry: CaptureMeta | null;
  loading: boolean;
}

/**
 * Resolve a single library entry by id for the large palette view.
 *
 * Palette entries are aux-catalog rows (no per-entry IPC), so this finds
 * the row in the full `library_list` and re-resolves on
 * `clippity://library/updated` — so the open view reflects a rename /
 * delete that happens elsewhere. Includes trashed rows so a palette that
 * gets trashed while open still resolves (the view can show its state).
 * Resolves to `null` when `id` is null or the entry no longer exists.
 */
export function usePaletteEntry(id: string | null): UsePaletteEntryResult {
  const [entry, setEntry] = useState<CaptureMeta | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setEntry(null);
      setLoading(false);
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const items = await libraryList(true);
        if (alive) setEntry(items.find((m) => m.id === id) ?? null);
      } catch {
        if (alive) setEntry(null);
      } finally {
        if (alive) setLoading(false);
      }
    };
    setLoading(true);
    void load();
    const off = onLibraryUpdated(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, [id]);

  return { entry, loading };
}
