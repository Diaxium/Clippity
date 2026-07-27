/**
 * Library-backed data for the Home view.
 *
 * One `library_list` fetch feeds three cards, each a different slice of
 * the same newest-first list:
 *
 *  - **recent**   — the newest file-backed captures (the thumbnail strip)
 *  - **editing**  — resume-in-editor list: editor exports (`mode:
 *                   "Edited"`) first, then filled with the most recent
 *                   captures so the card isn't empty on a fresh library
 *  - **activity** — the newest captures as a compact log
 *
 * Aux entries (color / palette / text) are excluded everywhere — they
 * have no file to reopen in the editor and no thumbnail to show. Refetches
 * automatically on `clippity://library/updated` (a capture landing, or a
 * delete / restore anywhere). Errors leave the lists empty and render the
 * cards' empty states rather than throwing.
 */

import { useEffect, useMemo, useState } from "react";

import {
  libraryList,
  onLibraryUpdated,
  type CaptureKind,
  type CaptureMeta,
} from "@services/tauri/clients/library";

/** Kinds that have a file on disk (a thumbnail + an editor target). */
const FILE_KINDS: ReadonlySet<CaptureKind> = new Set([
  "image",
  "video",
  "gif",
]);

const RECENT_COUNT = 4;
const EDITING_COUNT = 3;
const ACTIVITY_COUNT = 4;

export interface HomeCaptures {
  recent: CaptureMeta[];
  editing: CaptureMeta[];
  activity: CaptureMeta[];
  /** Total file-backed captures (not sliced) — for the Storage card. */
  count: number;
  loading: boolean;
}

export function useHomeCaptures(): HomeCaptures {
  const [items, setItems] = useState<CaptureMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await libraryList(false);
        if (!cancelled) setItems(next ?? []);
      } catch {
        // Browser preview / no captures dir yet — render empty states.
        if (!cancelled) setItems([]);
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

  return useMemo(() => {
    const files = items.filter((c) => !c.trashed && FILE_KINDS.has(c.kind));

    const recent = files.slice(0, RECENT_COUNT);

    // Editor exports first (the literal "continue editing" case), then
    // top up with the most recent captures, de-duplicated by id.
    const edited = files.filter((c) => c.mode === "Edited");
    const seen = new Set(edited.map((c) => c.id));
    const editing = [
      ...edited,
      ...files.filter((c) => !seen.has(c.id)),
    ].slice(0, EDITING_COUNT);

    const activity = files.slice(0, ACTIVITY_COUNT);

    return { recent, editing, activity, count: files.length, loading };
  }, [items, loading]);
}
