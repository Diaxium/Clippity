/**
 * Library feature types. Wire types live in
 * `@services/tauri/clients/library` (per ADR 0001); re-exported here
 * so feature-internal components import from one place. UI-only
 * types are defined locally.
 */

export type {
  AuxColor,
  CaptureKind,
  CaptureMeta,
  LibraryFacets,
  LibraryFacetsQuery,
  LibraryQuery,
  SmartCounts,
  StorageInfo,
  TagCount,
  TrashFilter,
} from "@services/tauri/clients/library";

export type { Collection } from "@services/tauri/clients/collections";

/** Which capture set the page is showing. */
export type LibraryMode = "library" | "trash";

/** Grid vs. list rendering of the same items. */
export type LibraryView = "grid" | "list";

/** Kind filter tab. File-backed kinds + the armed aux kinds
 *  (color / palette / text). */
export type KindTab =
  "all" | "image" | "video" | "gif" | "color" | "palette" | "text";

/** How the grid orders the captures it is showing. */
export type LibrarySort = "newest" | "oldest" | "name" | "largest";

/**
 * A smart collection: a **rule** over the listing, not a curated
 * document. Where a `Collection` remembers which captures the user put in
 * it and in what order, one of these is recomputed from the list every
 * render — "this week" means whatever this week means today.
 */
export type SmartId = "this-week" | "last-30-days" | "large" | "untagged";

/**
 * What the sidebar is pointing at — the one destination the grid is
 * showing.
 *
 * Exactly one is active at a time, which is the difference between a
 * *scope* and a *refinement*: the tag chips and the search box narrow
 * whatever scope is open (they AND with it), while picking a scope
 * replaces the previous one wholesale. Modelled as a union rather than
 * as the five independent store fields it resolves to, so "which row is
 * highlighted" has a single answer instead of being reconstructed from a
 * combination that could, in principle, be incoherent.
 */
export type LibraryScope =
  | { kind: "all" }
  | { kind: "kind"; value: KindTab }
  | { kind: "favorites" }
  | { kind: "trash" }
  | { kind: "collection"; id: string }
  | { kind: "smart"; id: SmartId };
