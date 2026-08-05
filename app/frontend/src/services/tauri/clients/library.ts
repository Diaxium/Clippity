/**
 * Library IPC client.
 *
 * Per [ADR 0001](../../../../docs/decisions/0001-capture-overlay-dispatch.md),
 * typed IPC wrappers live under `services/tauri/clients/` so cross-feature
 * consumers (the capture-window's LibraryLayout, a future editor "open from
 * library", a future toast "Open Library" handoff) import from one place —
 * never from `features/library/`. The wire-format types live in
 * `@clippity/shared` and are re-exported here for backwards compat.
 *
 * Rust side: `domain::library::*` + `services::library_service::*`.
 *
 * Two families of entry share this shape: **file-backed** captures
 * (`image` / `video` / `gif`), which are files in the captures dir, and
 * **aux** entries (`color` / `palette` / `text`), which have no file and
 * live in the aux catalog.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import type {
  CaptureMeta,
  CapturePage,
  LibraryFacets,
  LibraryFacetsQuery,
  LibraryQuery,
  StorageInfo,
} from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::library`) ----------
export type {
  CaptureKind,
  AuxColor,
  CaptureMeta,
  CapturePage,
  LibraryFacets,
  LibraryFacetsQuery,
  LibraryQuery,
  LibrarySort,
  SmartCounts,
  StorageInfo,
  TagCount,
  TrashFilter,
} from "@clippity/shared";

// ---------- IPC wrappers ----------

/**
 * Enumerate the captures dir (+ `.trash` if requested) as a
 * newest-first list. Missing dir resolves to an empty array.
 *
 * Served from a SQLite cache that is reconciled against the filesystem
 * before every call, so the answer is always what is on disk — the
 * cache only saves re-reading each capture's provenance record.
 *
 * Rust route: `app::commands::library_list` →
 * `services::library_service::LibraryService::list`.
 */
export function libraryList(includeTrashed: boolean): Promise<CaptureMeta[]> {
  return invoke<CaptureMeta[], { includeTrashed: boolean }>("library_list", {
    includeTrashed,
  });
}

/**
 * One filtered / searched / sorted **page** of the listing, with the
 * narrowing pushed into SQL so a large library returns only the rows a
 * page shows (performance roadmap P5). `total` is the full match count for
 * scrollbar sizing. Smart collections and collection membership are not
 * expressible in a query and stay client-side.
 *
 * Rust route: `app::commands::library_query` →
 * `services::library_service::LibraryService::query`.
 */
export function libraryQuery(query: LibraryQuery): Promise<CapturePage> {
  return invoke<CapturePage, { query: LibraryQuery }>("library_query", {
    query,
  });
}

/**
 * Every count the library's destination rail shows, over the whole
 * library rather than the page the grid holds (performance roadmap P5).
 *
 * Separate from {@link libraryQuery} on purpose: a page cannot answer
 * "how big is every other scope", so a rail built from a listing forces
 * the full-library load that paging exists to avoid.
 *
 * Rust route: `app::commands::library_facets` →
 * `services::library_service::LibraryService::facets`.
 */
export function libraryFacets(
  query: LibraryFacetsQuery
): Promise<LibraryFacets> {
  return invoke<LibraryFacets, { query: LibraryFacetsQuery }>(
    "library_facets",
    { query }
  );
}

/**
 * Decode + downscale the file at `id` to `maxWidth`, returning a
 * base64 PNG data URI. The `useThumbnail` hook caches the result;
 * the backend re-decodes on every call.
 */
export function libraryThumbnail(
  id: string,
  maxWidth: number
): Promise<string> {
  return invoke<string, { id: string; maxWidth: number }>("library_thumbnail", {
    id,
    maxWidth,
  });
}

/** Soft-delete `id` (move to `<captures>/.trash/`). Returns the new
 *  trashed-path id. Backend emits `library/updated`. */
export function libraryDelete(id: string): Promise<string> {
  return invoke<string, { id: string }>("library_delete", { id });
}

/** Restore a trashed capture back to `<captures>/`. Returns the new
 *  restored-path id. Backend emits `library/updated`. */
export function libraryRestore(id: string): Promise<string> {
  return invoke<string, { id: string }>("library_restore", { id });
}

/** Permanently delete `id` from disk. Backend emits
 *  `library/updated`. */
export function libraryPurge(id: string): Promise<void> {
  return invoke<void, { id: string }>("library_purge", { id });
}

/** Recursive byte-count of the captures dir + a fixed display cap. */
export function libraryStorage(): Promise<StorageInfo> {
  return invoke<StorageInfo>("library_storage");
}

/**
 * Throw the backend's listing cache away and rebuild it from disk,
 * resolving to the number of rows. Backend emits `library/updated`.
 *
 * Nothing in normal use needs this: `libraryList` reconciles the cache
 * against the filesystem on every call, so it cannot go stale. It is
 * the manual repair for the one blind spot that reconciliation has — a
 * capture rewritten within the same millisecond, and to the same byte
 * count, as the one it replaced.
 */
export function libraryReindex(): Promise<number> {
  return invoke<number>("library_reindex");
}

// ---------- Labels (tags + favorite) ----------
//
// Every one of these takes an **id list**, so tagging one capture and
// tagging a selection of forty are the same call — bulk operations need
// no fan-out here and no second code path in the backend (ADR 0029).
// Each resolves to how many entries actually changed; an edit that asks
// for what is already true writes nothing and emits nothing.

/** Star or unstar every id. */
export function librarySetFavorite(
  ids: string[],
  favorite: boolean
): Promise<number> {
  return invoke<number, { ids: string[]; favorite: boolean }>(
    "library_set_favorite",
    { ids, favorite }
  );
}

/** Merge `tags` into each id's existing tags. */
export function libraryAddTags(ids: string[], tags: string[]): Promise<number> {
  return invoke<number, { ids: string[]; tags: string[] }>("library_add_tags", {
    ids,
    tags,
  });
}

/** Drop `tags` from each id. Matching ignores case. */
export function libraryRemoveTags(
  ids: string[],
  tags: string[]
): Promise<number> {
  return invoke<number, { ids: string[]; tags: string[] }>(
    "library_remove_tags",
    { ids, tags }
  );
}

/** Replace each id's tag list wholesale — the tag editor's "done". */
export function librarySetTags(ids: string[], tags: string[]): Promise<number> {
  return invoke<number, { ids: string[]; tags: string[] }>("library_set_tags", {
    ids,
    tags,
  });
}

// ---------- Event listeners ----------

/**
 * Subscribe to `clippity://library/updated`. Backend emits this
 * after any filesystem change in the captures dir (a new capture
 * lands, or a delete / restore / purge runs). Empty payload — the
 * handler should re-fetch.
 *
 * Returns a sync unsubscribe — return it directly from a `useEffect`.
 */
export function onLibraryUpdated(handler: () => void): () => void {
  return on<unknown>(EVENT_NAMES.libraryUpdated, () => handler());
}
