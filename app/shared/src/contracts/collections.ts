/**
 * Collections wire-format contracts — mirror Rust `domain::collections`.
 *
 * A collection is a named, manually ordered set of captures. Membership
 * is by capture id, the same id `CaptureMeta.id` carries.
 */

export interface Collection {
  /** Stable synthetic id (`col_<ms>_<seq>`), never derived from the
   *  name — renaming must not orphan a collection. */
  id: string;
  name: string;
  createdAtMs: number;
  /** Last change to the name or the membership. */
  updatedAtMs: number;
  /** Capture ids in curated order — *not* newest-first like the
   *  library. An id whose capture is missing (trashed, on a
   *  disconnected drive) stays in the list and is simply skipped when
   *  rendering; it is only dropped when the capture is purged. */
  members: string[];
}
