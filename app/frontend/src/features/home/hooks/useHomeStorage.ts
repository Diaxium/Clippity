/**
 * Live storage usage for the Home "Storage" card.
 *
 * `library_storage` returns the recursive byte-count of the captures
 * dir plus a fixed display cap. Refetched on `clippity://library/updated`
 * so the meter tracks new captures + deletions. Errors resolve to a
 * zeroed reading (the card renders "0 MB used").
 */

import { useEffect, useState } from "react";

import {
  libraryStorage,
  onLibraryUpdated,
  type StorageInfo,
} from "@services/tauri/clients/library";

export interface HomeStorage {
  info: StorageInfo | null;
  /** 0–100, clamped; 0 when nothing is known yet. */
  percent: number;
  loading: boolean;
}

export function useHomeStorage(): HomeStorage {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await libraryStorage();
        if (!cancelled) setInfo(next);
      } catch {
        if (!cancelled) setInfo(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void refresh();
    const unsub = onLibraryUpdated(() => void refresh());
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const percent =
    info && info.totalBytes > 0
      ? Math.min(100, Math.round((info.usedBytes / info.totalBytes) * 100))
      : 0;

  return { info, percent, loading };
}
