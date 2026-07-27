/**
 * Collections IPC client.
 *
 * A collection is a **named, manually ordered set of captures**. Unlike
 * tags and the favorite flag — which are properties of a capture and ride
 * in a sidecar beside it — a collection has its own name and its own
 * order, so it is its own document, `<captures>/collections.json`, and its
 * own IPC surface
 * ([ADR 0029](../../../../docs/decisions/0029-labels-are-a-sidecar-collections-are-a-document.md)).
 *
 * Membership is by capture id, the same id `CaptureMeta.id` carries. The
 * wire-format types live in `@clippity/shared` and are re-exported here.
 *
 * Rust side: `domain::collections::*` + `services::collections_service`.
 */

import { EVENT_NAMES, invoke, on } from "@services/tauri";
import type { Collection } from "@clippity/shared";

// ---------- Wire-format types (mirror Rust `domain::collections`) ----------
export type { Collection } from "@clippity/shared";

// ---------- IPC wrappers ----------

/** Every collection, in creation order. */
export function collectionsList(): Promise<Collection[]> {
  return invoke<Collection[]>("collections_list");
}

/** Create an empty collection. Rejects a blank name. */
export function collectionsCreate(name: string): Promise<Collection> {
  return invoke<Collection, { name: string }>("collections_create", { name });
}

/** Rename. Duplicate names are allowed — the id is the identity. */
export function collectionsRename(
  id: string,
  name: string
): Promise<Collection> {
  return invoke<Collection, { id: string; name: string }>(
    "collections_rename",
    { id, name }
  );
}

/** Delete the collection. The captures in it are untouched. */
export function collectionsRemove(id: string): Promise<void> {
  return invoke<void, { id: string }>("collections_remove", { id });
}

/** Append captures, skipping ones already in the collection. */
export function collectionsAddMembers(
  id: string,
  captureIds: string[]
): Promise<Collection> {
  return invoke<Collection, { id: string; captureIds: string[] }>(
    "collections_add_members",
    { id, captureIds }
  );
}

/** Remove captures from the collection. */
export function collectionsRemoveMembers(
  id: string,
  captureIds: string[]
): Promise<Collection> {
  return invoke<Collection, { id: string; captureIds: string[] }>(
    "collections_remove_members",
    { id, captureIds }
  );
}

/**
 * Rearrange to `captureIds`.
 *
 * Members the list forgets keep their relative place at the end rather
 * than being dropped — a reorder computed before another window added a
 * capture must not delete it.
 */
export function collectionsSetOrder(
  id: string,
  captureIds: string[]
): Promise<Collection> {
  return invoke<Collection, { id: string; captureIds: string[] }>(
    "collections_set_order",
    { id, captureIds }
  );
}

// ---------- Event listeners ----------

/**
 * Subscribe to `clippity://collections/updated` — emitted after any
 * create / rename / delete / membership / reorder.
 *
 * Deliberately separate from `library/updated`: a capture joining a
 * collection changes no row in a listing, so sharing the event would
 * make every library view re-fetch its whole list over an arrangement it
 * isn't showing.
 *
 * Returns a sync unsubscribe — return it directly from a `useEffect`.
 */
export function onCollectionsUpdated(handler: () => void): () => void {
  return on<unknown>(EVENT_NAMES.collectionsUpdated, () => handler());
}
