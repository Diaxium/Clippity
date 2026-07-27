/**
 * Library wire-format contracts — mirror Rust `domain::library`
 * (+ `domain::metadata` provenance and `domain::labels`).
 *
 * Two families of entry share this shape: **file-backed** captures
 * (`image` / `video` / `gif`), which are files in the captures dir, and
 * **aux** entries (`color` / `palette` / `text`), which have no file and
 * live in the aux catalog.
 */

export type CaptureKind = "image" | "video" | "gif" | "color" | "palette" | "text";

/** A sampled / quantized color stored in the aux catalog. */
export interface AuxColor {
  hex: string;
  r: number;
  g: number;
  b: number;
  /** Palette-swatch share of the source region (0–1, dominant first;
   *  proportions across a palette sum to ~1). Absent for a single sampled
   *  color (color-pick) and for palettes saved before proportions were
   *  tracked. */
  proportion?: number;
}

export interface CaptureMeta {
  /** File path (file-backed entries) OR a synthetic `aux_<kind>_<ms>`
   *  id (color / palette / text). File ids change when a file moves
   *  to/from trash — react to `clippity://library/updated` (or re-list)
   *  to find the new id; aux ids are stable across delete/restore. */
  id: string;
  /** Card title — file stem, or the dominant hex for aux entries. */
  title: string;
  kind: CaptureKind;
  /** When the capture was taken, from its provenance record — falling
   *  back to the file's mtime for captures saved before records
   *  existed. */
  createdAtMs: number;
  sizeBytes: number;
  /** True when soft-deleted (file under `.trash/`, or aux `trashed`). */
  trashed: boolean;
  /** Aux payload — present only for the matching `kind` (absent on
   *  file-backed entries). */
  color?: AuxColor;
  palette?: AuxColor[];
  text?: string;

  // ---------- Provenance (Rust `domain::metadata`) ----------
  // Read from the capture's `.meta` sidecar during the library scan.
  // Every field is optional and absent for aux entries, for captures
  // saved before sidecars shipped, and whenever the owning process
  // couldn't be resolved (elevated/protected windows).

  /** Application that owned the captured window — `"Chrome"`, `"Code"`. */
  sourceApp?: string;
  /** Title of the captured window. */
  sourceWindow?: string;
  /** Capture mode that produced it — `"Region"`, `"Fullscreen"`,
   *  `"Scrolling"`, `"Edited"`, … */
  mode?: string;
  /** Pixel dimensions. Absent for editor exports, whose bytes the
   *  backend deliberately never decodes. */
  width?: number;
  height?: number;
  /** Display the capture came from — `"Display 1"`, `"Display 2"`.
   *  Attributed by area, so a selection straddling two screens names
   *  the one it mostly sat on. Absent when the capture has no screen of
   *  origin (a clipboard ingest, an editor export). */
  monitor?: string;
  /** Name of the capture preset that produced it. Absent for every
   *  interactive capture — which is most of them. */
  preset?: string;

  // ---------- Labels (Rust `domain::labels`) ----------
  // What the *user* says about a capture. For a file-backed capture
  // these come from its `.labels` sidecar; for an aux entry, from its
  // catalog row. Both absent when there is nothing to say.

  /** Freeform tags, already normalised and sorted by the backend. */
  tags?: string[];
  /** Pinned by the user. */
  favorite?: boolean;
}

/** How a {@link LibraryQuery} orders its page. Mirrors Rust
 *  `services::library_index::QuerySort` and the library's `LibrarySort`. */
export type LibrarySort = "newest" | "oldest" | "name" | "largest";

/**
 * A filtered / searched / sorted page request, pushed into SQL so a large
 * library materializes only the rows a page shows (performance roadmap
 * P5). Every field is optional; `{}` is "the first page of everything,
 * newest first".
 *
 * Mirrors Rust `commands::LibraryQueryArgs` → `library_index::LibraryQuery`.
 * Smart collections and collection membership are not expressible here and
 * stay client-side.
 */
/**
 * Which half of the library a page reads. Mirrors Rust
 * `library_index::TrashFilter`.
 *
 * A tri-state rather than `library_list`'s superset `includeTrashed`
 * bool, because a page has to express what a full listing never did: the
 * trash view shows the deleted half **only**, and a grid holding one page
 * has no other rows to split.
 */
export type TrashFilter = "exclude" | "include" | "only";

export interface LibraryQuery {
  /** Default `"exclude"` — live captures only. */
  trash?: TrashFilter;
  /** Keep only this kind; omit for every kind. */
  kind?: CaptureKind;
  favoritesOnly?: boolean;
  /** Keep only rows carrying this tag (case-insensitive). */
  tag?: string;
  /** Case-insensitive substring across title, provenance, grabbed text,
   *  tags and swatch hexes. Blank / absent matches all. */
  search?: string;
  sort?: LibrarySort;
  /** Page size; omit for the whole matching set. */
  limit?: number;
  /** Rows to skip before the page. */
  offset?: number;
}

/** One page of a {@link LibraryQuery}, plus the total rows the filters
 *  match before `limit`/`offset` — a virtualized grid sizes its scrollbar
 *  from `total` while holding only `items`. */
export interface CapturePage {
  items: CaptureMeta[];
  total: number;
}

/**
 * The thresholds the library rail's derived ("smart") sets are cut at.
 *
 * Sent by the client rather than decided by the backend because they are
 * anchored to the user's clock: "this week" counts back six calendar days
 * from *local* midnight, which the backend has no timezone to compute.
 * Keeping the boundary here means one definition of each window —
 * `matchesSmart` — instead of a second one in SQL that could drift.
 *
 * Mirrors Rust `commands::LibraryFacetsArgs` → `library_index::FacetsQuery`.
 */
export interface LibraryFacetsQuery {
  thisWeekSinceMs: number;
  last30DaysSinceMs: number;
  largeMinBytes: number;
}

/** One tag and how many live captures carry it. */
export interface TagCount {
  /** Display spelling. Spellings are folded case-insensitively, so a tag
   *  written `Bug` and `bug` is counted once. */
  tag: string;
  count: number;
}

/** Sizes of the rail's derived sets, cut at {@link LibraryFacetsQuery}. */
export interface SmartCounts {
  thisWeek: number;
  last30Days: number;
  large: number;
  untagged: number;
}

/**
 * Every count the library's destination rail shows, aggregated over the
 * **whole** library rather than the page the grid is holding.
 *
 * This is the other half of a paged library (performance roadmap P5). A
 * page can say what is in one scope; it cannot say how big every *other*
 * scope is, and deriving that in the client means loading the full
 * listing — the exact cost pushing the grid into SQL removes.
 *
 * Deliberately not narrowed by the active scope or search: the rail is a
 * map of the library, so "Videos 12" means twelve videos exist, not
 * twelve that survive the search box. Every count except `trashed` is
 * over live rows.
 */
export interface LibraryFacets {
  total: number;
  /** Live captures per kind; a kind with none is absent, not `0`. */
  kinds: Partial<Record<CaptureKind, number>>;
  favorites: number;
  trashed: number;
  /** The vocabulary the library grew, ordered by tag. */
  tags: TagCount[];
  smart: SmartCounts;
}

export interface StorageInfo {
  usedBytes: number;
  /** Fixed 10 GiB display cap (cross-platform free-disk-space is
   *  unreliable via Tauri v2's path API). */
  totalBytes: number;
}
