/**
 * Label mutations, with the error handling every call site would
 * otherwise repeat.
 *
 * These are one line of IPC each, but every one of them is fired from a
 * card, a row, the tag editor *and* the selection bar — four places that
 * would each need the same try/catch and the same toast. Wrapping them
 * once keeps a failed write from being swallowed silently.
 *
 * Nothing here holds state: the backend emits `library/updated` when an
 * edit lands, and `useLibraryList` re-fetches on it. A caller does not
 * need the return value, but gets it — the number of entries actually
 * changed, which is `0` when the edit asked for what was already true.
 */

import {
  libraryAddTags,
  libraryRemoveTags,
  librarySetFavorite,
  librarySetTags,
} from "@services/tauri/clients/library";
import { emitErrorToast } from "@services/tauri/clients/toast";

async function guarded(
  run: () => Promise<number>,
  failure: string
): Promise<number> {
  try {
    return await run();
  } catch (err) {
    void emitErrorToast(err instanceof Error ? err.message : failure);
    return 0;
  }
}

/** Star or unstar every id — one capture or a whole selection. */
export function setFavorite(ids: string[], favorite: boolean): Promise<number> {
  return guarded(
    () => librarySetFavorite(ids, favorite),
    favorite ? "Failed to favorite." : "Failed to unfavorite."
  );
}

/** Merge `tags` into each id's existing tags. */
export function addTags(ids: string[], tags: string[]): Promise<number> {
  return guarded(() => libraryAddTags(ids, tags), "Failed to add the tag.");
}

/** Drop `tags` from each id. */
export function removeTags(ids: string[], tags: string[]): Promise<number> {
  return guarded(
    () => libraryRemoveTags(ids, tags),
    "Failed to remove the tag."
  );
}

/** Replace each id's tag list wholesale. */
export function setTags(ids: string[], tags: string[]): Promise<number> {
  return guarded(() => librarySetTags(ids, tags), "Failed to save the tags.");
}
