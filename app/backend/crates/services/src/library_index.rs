//! The library **index** — a SQLite cache over the filesystem, never a
//! second source of truth.
//!
//! The library's data lives on disk: a capture *is* its file, and its
//! description is the `.meta` sidecar beside it (ADR 0026). That model
//! is worth keeping — it survives a reinstall, a sync client, a manual
//! copy — but it costs one `open` + `read` + JSON parse per capture on
//! every listing, and it can only answer questions by re-reading
//! everything. This module is the cache that fixes both without moving
//! the data.
//!
//! **The contract that makes it safe:** the index is only ever read
//! *after* being reconciled against the filesystem, and reconciliation
//! is driven by a [`Stamp`] — the capture file's mtime and size plus its
//! sidecar's mtime. A row whose stamp still matches disk is served from
//! SQLite; a row whose stamp moved is rebuilt from disk; a row whose
//! file is gone is deleted. So the index cannot serve an answer the
//! filesystem disagrees with, and "rebuildable at any time" is a
//! property of the design rather than a maintenance command. See
//! `library_service::list` for the reconcile loop, and ADR 0028.
//!
//! What it buys: an unchanged library lists with N `stat` calls instead
//! of N file reads and JSON parses. What it unlocks: Library P3's
//! filters and search become `WHERE` clauses over columns that already
//! exist, and Vision P4's OCR text attaches to these same rows via FTS5.
//!
//! **Columns for what the catalog will be searched by; JSON for what it
//! will only be shown with.** Every provenance field is a real column
//! (they are all filter facets in Library P3), grabbed text is a real
//! column (it is the full-text target), the favorite flag is a real
//! column (a one-click filter), and the colour/palette swatches —
//! display payloads no query will ever key on — ride in one JSON column
//! rather than widening the schema with shapes nothing filters.
//!
//! Tags sit between the two: they *are* a filter facet, but a row has
//! many of them, and the shape SQLite wants for that is a second table
//! and a join. One JSON column plus an in-memory predicate is what the
//! library needs today; the join is what Library P3 can grow into when a
//! tag filter has to be a `WHERE` clause rather than a `.filter()`. The
//! column is the same either way — see ADR 0029.
//!
//! Failure is never fatal. Every method returns `AppResult`, and the
//! caller's answer to an error is to fall back to scanning, which is
//! exactly what the library did before this module existed.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use clippity_domain::library::{AuxColor, CaptureKind, CaptureMeta};
use clippity_infra::error::{AppError, AppResult};

/// Schema version stamped into SQLite's `user_version`. Bump on any
/// change to the table shape. There is no migration path and there
/// shouldn't be: the index is a cache, so a version mismatch drops the
/// table and lets the next reconcile refill it from disk.
const SCHEMA_VERSION: i64 = 3;

/// The columns a [`CaptureMeta`] is read back from, in the order
/// [`read_row`] indexes them. Shared by every SELECT so the projection
/// and the mapper can't drift. `search_blob` is deliberately absent — it
/// is a query-only column, never read into a row.
const ROW_COLUMNS: &str = "id, title, kind, created_at_ms, size_bytes, trashed,
     source_app, source_window, mode, width, height,
     monitor, preset, text, swatches, tags, favorite";

/// File name of the index database under the app data directory.
pub const DB_FILE_NAME: &str = "library.db";

/// What a row was built from — the disk state that, unchanged, means
/// the cached row is still true.
///
/// The sidecar mtimes are in here alongside the capture's own because
/// the records are half the row: a record rewritten without the pixels
/// being touched (a hand edit, a tag added, a star toggled) has to
/// invalidate the row too, or the index would serve a description its
/// source no longer agrees with. Each costs one extra `stat` on a
/// directory entry the walk has already warmed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stamp {
    /// Capture file's modified time, epoch ms. `0` when unreadable.
    pub mtime_ms: i64,
    /// Capture file's size in bytes.
    pub size_bytes: i64,
    /// `.meta` sidecar's modified time, epoch ms. `0` when there is
    /// none — which is a stable answer, not a missing one.
    pub meta_ms: i64,
    /// `.labels` sidecar's modified time, epoch ms. `0` when there is
    /// none — and un-labelling a capture *deletes* that sidecar rather
    /// than emptying it (`sidecar::write_labels`), so a capture that was
    /// tagged and untagged stamps identically to one never tagged.
    pub labels_ms: i64,
}

/// The colour payloads a row carries for display only. Serialized into
/// one JSON column: nothing filters or sorts on a swatch, so giving
/// them columns would widen the schema for no query.
#[derive(Serialize, Deserialize, Default)]
struct Swatches {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<AuxColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    palette: Option<Vec<AuxColor>>,
}

/// How a [`LibraryQuery`] orders its page. Mirrors the frontend
/// `LibrarySort`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum QuerySort {
    #[default]
    Newest,
    Oldest,
    Name,
    Largest,
}

/// Which half of the library a query reads.
///
/// A tri-state rather than [`LibraryIndex::rows`]'s `include_trashed`
/// bool because a *page* has to express something a full listing never
/// did: the trash view shows the deleted half **only**. `list` can hand
/// back the superset and let the client split it, but a grid that
/// materializes one page has no other rows to split.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TrashFilter {
    /// Live captures only — the library view.
    #[default]
    Exclude,
    /// Both halves — the superset `library_list` returns.
    Include,
    /// Soft-deleted captures only — the trash view.
    Only,
}

impl TrashFilter {
    /// Does answering this need the trash directory walked? Drives the
    /// scan fallback's `include_trashed`, which is still a superset flag.
    pub fn needs_trash(self) -> bool {
        !matches!(self, TrashFilter::Exclude)
    }
}

/// A pushed-down library query: the filters, search and sort the grid
/// applies over the whole listing, expressed so only the visible page is
/// materialized. Every field defaults, so `LibraryQuery::default()` is
/// "the first page of everything, newest first" — the listing's default.
#[derive(Clone, Debug, Default)]
pub struct LibraryQuery {
    /// Which half of the library to read. Default: live only.
    pub trash: TrashFilter,
    /// Keep only this kind. `None` = every kind.
    pub kind: Option<CaptureKind>,
    /// Keep only favorited rows.
    pub favorites_only: bool,
    /// Keep only rows carrying this tag (case-insensitive). `None` = any.
    pub tag: Option<String>,
    /// Case-insensitive substring across title, provenance, grabbed text,
    /// tags and swatch hexes. Blank / `None` matches all.
    pub search: Option<String>,
    pub sort: QuerySort,
    /// Page size. `None` = the whole matching set (no limit).
    pub limit: Option<u32>,
    /// Rows to skip before the page.
    pub offset: u32,
}

/// One page of a [`LibraryQuery`], plus the total rows the filters match
/// before `limit`/`offset` — a virtualized grid sizes its scrollbar from
/// `total` while only ever holding `items`.
pub struct QueryPage {
    pub items: Vec<CaptureMeta>,
    pub total: u64,
}

/// The thresholds the rail's derived sets are cut at.
///
/// They arrive from the caller rather than being decided here because
/// they are *view* policy anchored to the user's clock: "this week"
/// counts back six calendar days from local midnight, which only the
/// frontend knows (the backend has no timezone and no idea when the
/// user's day starts). Passing the boundary in keeps one definition of
/// each window — the frontend's `matchesSmart` — instead of a second one
/// here that could drift from it.
#[derive(Clone, Copy, Debug, Default)]
pub struct FacetsQuery {
    /// Rows created at or after this instant are "this week".
    pub this_week_since_ms: i64,
    /// Rows created at or after this instant are "last 30 days".
    pub last_30_days_since_ms: i64,
    /// Rows at or above this size are "large files".
    pub large_min_bytes: i64,
}

/// One tag and how many live captures carry it.
pub struct TagCount {
    /// Display spelling — the library preserves what the user typed while
    /// treating `Bug` and `bug` as one tag, so a tag with mixed spellings
    /// is counted once and shown under its lowest-sorting form.
    pub tag: String,
    pub count: u64,
}

/// Sizes of the rail's derived sets, cut at [`FacetsQuery`]'s thresholds.
#[derive(Default)]
pub struct SmartCounts {
    pub this_week: u64,
    pub last_30_days: u64,
    pub large: u64,
    pub untagged: u64,
}

/// Every count the library's destination rail shows beside a row, over
/// the **whole** library rather than the page a grid is holding.
///
/// This exists because the rail and the grid ask different questions. The
/// grid asks "what is in this scope, in this order, on this page" — which
/// [`LibraryQuery`] answers by materializing only that page. The rail asks
/// "how big is every scope", which no page can answer: it is an aggregate
/// over all rows, and deriving it in the client is exactly the full-listing
/// load that pushing the query into SQL was meant to remove (performance
/// roadmap P5).
///
/// Deliberately *not* narrowed by the active scope or search. A rail is a
/// map of the library, so "Videos 12" means twelve videos exist, not
/// twelve that survive whatever is typed in the search box. Every count
/// except `trashed` is over live rows, so clicking a row never lands
/// somewhere emptier than its label promised.
#[derive(Default)]
pub struct LibraryFacets {
    /// Live captures — the rail's "All media".
    pub total: u64,
    /// Live captures per kind. Absent = none, which the caller reads as 0.
    pub kinds: HashMap<CaptureKind, u64>,
    pub favorites: u64,
    /// Soft-deleted captures — the only count over the trashed half.
    pub trashed: u64,
    /// The vocabulary the library grew, ordered by tag.
    pub tags: Vec<TagCount>,
    pub smart: SmartCounts,
}

impl LibraryQuery {
    /// The in-memory twin of [`LibraryIndex::query`], for the scan
    /// fallback: when there is no index (a read-only data directory) or it
    /// failed mid-flight, the degraded path must still return the page the
    /// SQL path would. Kept beside the SQL, with a parity test pinning the
    /// two together, so a change to one that forgets the other is caught.
    /// `rows` is the (unpaginated) candidate set — the scan's whole
    /// listing, which must include trashed rows whenever
    /// [`TrashFilter::needs_trash`].
    pub fn apply_in_memory(&self, rows: Vec<CaptureMeta>) -> QueryPage {
        let needle = self
            .search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_lowercase);
        let tag = self
            .tag
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_lowercase);

        let mut matched: Vec<CaptureMeta> = rows
            .into_iter()
            .filter(|m| {
                match self.trash {
                    TrashFilter::Exclude if m.trashed => return false,
                    TrashFilter::Only if !m.trashed => return false,
                    _ => {}
                }
                if let Some(k) = self.kind {
                    if m.kind != k {
                        return false;
                    }
                }
                if self.favorites_only && !m.favorite {
                    return false;
                }
                if let Some(t) = &tag {
                    if !m.tags.iter().any(|x| x.to_lowercase() == *t) {
                        return false;
                    }
                }
                if let Some(n) = &needle {
                    if !search_blob(m).contains(n.as_str()) {
                        return false;
                    }
                }
                true
            })
            .collect();

        let newest = |a: &CaptureMeta, b: &CaptureMeta| {
            b.created_at_ms.cmp(&a.created_at_ms).then(a.id.cmp(&b.id))
        };
        match self.sort {
            QuerySort::Newest => matched.sort_by(newest),
            QuerySort::Oldest => {
                matched.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then(a.id.cmp(&b.id)))
            }
            QuerySort::Name => matched.sort_by(|a, b| {
                a.title
                    .to_lowercase()
                    .cmp(&b.title.to_lowercase())
                    .then_with(|| newest(a, b))
            }),
            QuerySort::Largest => {
                matched.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then_with(|| newest(a, b)))
            }
        }

        let total = matched.len() as u64;
        let start = (self.offset as usize).min(matched.len());
        let end = match self.limit {
            Some(n) => start.saturating_add(n as usize).min(matched.len()),
            None => matched.len(),
        };
        QueryPage {
            items: matched[start..end].to_vec(),
            total,
        }
    }
}

impl FacetsQuery {
    /// The in-memory twin of [`LibraryIndex::facets`], for the scan
    /// fallback — same contract as [`LibraryQuery::apply_in_memory`], and
    /// pinned to the SQL by a parity test. `rows` is the whole listing
    /// *including* trashed rows, since the trash count is taken over the
    /// half every other count excludes.
    pub fn apply_in_memory(&self, rows: &[CaptureMeta]) -> LibraryFacets {
        let mut facets = LibraryFacets::default();
        // Display spelling per lowercased tag, alongside the count, so a
        // tag written `Bug` once and `bug` twice counts three and shows
        // under one spelling — the same folding `hasTag` filters by.
        let mut tags: HashMap<String, (String, u64)> = HashMap::new();

        for m in rows {
            if m.trashed {
                facets.trashed += 1;
                continue;
            }
            facets.total += 1;
            *facets.kinds.entry(m.kind).or_insert(0) += 1;
            if m.favorite {
                facets.favorites += 1;
            }

            let created = clamp_ms(m.created_at_ms);
            if created >= self.this_week_since_ms {
                facets.smart.this_week += 1;
            }
            if created >= self.last_30_days_since_ms {
                facets.smart.last_30_days += 1;
            }
            if clamp_u64(m.size_bytes) >= self.large_min_bytes {
                facets.smart.large += 1;
            }
            if m.tags.is_empty() {
                facets.smart.untagged += 1;
            }

            // Case-folded within the row too: a row carrying both `Bug`
            // and `bug` is one capture with that tag, not two.
            let mut seen: Vec<String> = Vec::new();
            for tag in &m.tags {
                let key = tag.to_lowercase();
                if seen.contains(&key) {
                    continue;
                }
                seen.push(key.clone());
                let entry = tags.entry(key).or_insert_with(|| (tag.clone(), 0));
                if tag < &entry.0 {
                    entry.0 = tag.clone();
                }
                entry.1 += 1;
            }
        }

        let mut counted: Vec<(String, String, u64)> = tags
            .into_iter()
            .map(|(key, (display, count))| (key, display, count))
            .collect();
        counted.sort_by(|a, b| a.0.cmp(&b.0));
        facets.tags = counted
            .into_iter()
            .map(|(_, tag, count)| TagCount { tag, count })
            .collect();

        facets
    }
}

pub struct LibraryIndex {
    conn: Mutex<Connection>,
}

impl LibraryIndex {
    /// Open (creating if needed) the index at `path`.
    ///
    /// A database that cannot be brought to the current schema is
    /// deleted and recreated once — a corrupt cache is a cache to throw
    /// away, not an error to propagate. Only a second failure surfaces,
    /// and the library's answer to that is to scan.
    pub fn open(path: &Path) -> AppResult<Self> {
        match Self::try_open(path) {
            Ok(index) => Ok(index),
            Err(e) => {
                tracing::warn!(
                    "library index at {} unusable ({e}); recreating it",
                    path.display()
                );
                let _ = fs::remove_file(path);
                Self::try_open(path)
            }
        }
    }

    /// An index with no file behind it. Used by tests, and available as
    /// a degraded mode for a read-only data directory: the cache is
    /// then per-process, which is still better than none.
    pub fn in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory().map_err(sql_err("open in-memory"))?;
        Self::from_connection(conn)
    }

    fn try_open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::Library(format!("index: create dir: {e}")))?;
        }
        let conn = Connection::open(path).map_err(sql_err("open"))?;
        Self::from_connection(conn)
    }

    fn from_connection(conn: Connection) -> AppResult<Self> {
        // WAL keeps a reader from blocking the reconcile write, and a
        // torn write costs at most a rebuild. `NORMAL` fsyncs are the
        // right trade for a cache whose loss is recoverable by design.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        ensure_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError::Library("index: lock poisoned".into()))
    }

    /// Every cached row's id and the disk state it was built from. One
    /// query, and the whole input the reconcile loop needs to decide
    /// what to rebuild and what to drop.
    pub fn stamps(&self) -> AppResult<HashMap<String, Stamp>> {
        let conn = self.conn()?;
        let mut stmt = conn
            .prepare(
                "SELECT id, stamp_mtime_ms, stamp_size, stamp_meta_ms, stamp_labels_ms
                 FROM entries",
            )
            .map_err(sql_err("prepare stamps"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Stamp {
                        mtime_ms: row.get(1)?,
                        size_bytes: row.get(2)?,
                        meta_ms: row.get(3)?,
                        labels_ms: row.get(4)?,
                    },
                ))
            })
            .map_err(sql_err("query stamps"))?;
        let mut out = HashMap::new();
        for row in rows {
            let (id, stamp) = row.map_err(sql_err("read stamp"))?;
            out.insert(id, stamp);
        }
        Ok(out)
    }

    /// Insert or replace `rows`, in one transaction — a reconcile is
    /// all-or-nothing, so an interrupted one leaves the previous
    /// (still-valid, still-stamped) rows in place rather than a mix.
    pub fn put(&self, rows: &[(CaptureMeta, Stamp)]) -> AppResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(sql_err("begin put"))?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO entries (
                        id, title, kind, created_at_ms, size_bytes, trashed,
                        source_app, source_window, mode, width, height,
                        monitor, preset, text, swatches, tags, favorite,
                        stamp_mtime_ms, stamp_size, stamp_meta_ms,
                        stamp_labels_ms, search_blob
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                        ?21, ?22
                     )",
                )
                .map_err(sql_err("prepare put"))?;
            for (meta, stamp) in rows {
                stmt.execute(params![
                    meta.id,
                    meta.title,
                    kind_to_text(meta.kind),
                    clamp_ms(meta.created_at_ms),
                    clamp_u64(meta.size_bytes),
                    meta.trashed as i64,
                    meta.source_app,
                    meta.source_window,
                    meta.mode,
                    meta.width.map(i64::from),
                    meta.height.map(i64::from),
                    meta.monitor,
                    meta.preset,
                    meta.text,
                    swatches_to_json(meta),
                    tags_to_json(&meta.tags),
                    meta.favorite as i64,
                    stamp.mtime_ms,
                    stamp.size_bytes,
                    stamp.meta_ms,
                    stamp.labels_ms,
                    search_blob(meta),
                ])
                .map_err(sql_err("insert row"))?;
            }
        }
        tx.commit().map_err(sql_err("commit put"))
    }

    /// Drop the named rows — the reconcile's answer to files that are
    /// no longer on disk.
    pub fn remove(&self, ids: &[String]) -> AppResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction().map_err(sql_err("begin remove"))?;
        {
            let mut stmt = tx
                .prepare("DELETE FROM entries WHERE id = ?1")
                .map_err(sql_err("prepare remove"))?;
            for id in ids {
                stmt.execute(params![id]).map_err(sql_err("delete row"))?;
            }
        }
        tx.commit().map_err(sql_err("commit remove"))
    }

    /// Every row, newest first — the library listing.
    ///
    /// The tiebreak on `id` is deliberate: a directory scan's order is
    /// whatever the filesystem hands back, so two captures sharing a
    /// millisecond would otherwise swap places between listings. The
    /// scanning fallback sorts the same way, because the two paths must
    /// be indistinguishable to a caller.
    pub fn rows(&self, include_trashed: bool) -> AppResult<Vec<CaptureMeta>> {
        let conn = self.conn()?;
        let sql = format!(
            "SELECT {ROW_COLUMNS}
                   FROM entries
                   WHERE (?1 OR trashed = 0)
                   ORDER BY created_at_ms DESC, id ASC"
        );
        let mut stmt = conn.prepare(&sql).map_err(sql_err("prepare rows"))?;
        let rows = stmt
            .query_map(params![include_trashed], read_row)
            .map_err(sql_err("query rows"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(sql_err("read row"))?);
        }
        Ok(out)
    }

    /// Fetch one page of the listing with the grid's filters, search and
    /// sort pushed into SQL — so a 50k-row library materializes only the
    /// rows a page shows, not all of them (performance roadmap P5). The
    /// returned [`QueryPage::total`] is the count the same filters match
    /// before `limit`/`offset`, which is what a virtualized grid needs to
    /// size its scrollbar without reading every row.
    ///
    /// Semantics mirror the frontend `filterCaptures` / `matchesSearch` /
    /// `sortCaptures` so a caller can move a view onto this path without
    /// the result set shifting under it. The one deliberate difference is
    /// the name sort: SQLite's `NOCASE` collation rather than JS
    /// `localeCompare`'s numeric collation, so `clippity-10` and
    /// `clippity-2` order lexically here. Smart collections and collection
    /// membership are not expressible as a single WHERE and stay with the
    /// caller.
    pub fn query(&self, q: &LibraryQuery) -> AppResult<QueryPage> {
        let conn = self.conn()?;

        let mut clauses: Vec<String> = Vec::new();
        let mut args: Vec<Value> = Vec::new();

        match q.trash {
            TrashFilter::Exclude => clauses.push("trashed = 0".into()),
            TrashFilter::Only => clauses.push("trashed = 1".into()),
            TrashFilter::Include => {}
        }
        if let Some(kind) = q.kind {
            clauses.push("kind = ?".into());
            args.push(Value::Text(kind_to_text(kind)));
        }
        if q.favorites_only {
            clauses.push("favorite = 1".into());
        }
        if let Some(tag) = q.tag.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            // A row's tags live in a JSON array column; `json_each`
            // explodes it so a tag filter is a real WHERE rather than a
            // client-side `.some()`. Case-insensitive to match `hasTag`.
            clauses.push(
                "EXISTS (SELECT 1 FROM json_each(entries.tags) je \
                 WHERE lower(je.value) = ?)"
                    .into(),
            );
            args.push(Value::Text(tag.to_lowercase()));
        }
        if let Some(needle) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            clauses.push("search_blob LIKE ? ESCAPE '\\'".into());
            args.push(Value::Text(format!(
                "%{}%",
                escape_like(&needle.to_lowercase())
            )));
        }

        let where_sql = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };

        let total: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM entries {where_sql}"),
                params_from_iter(args.iter()),
                |r| r.get(0),
            )
            .map_err(sql_err("count query"))?;

        let order = match q.sort {
            QuerySort::Newest => "created_at_ms DESC, id ASC",
            QuerySort::Oldest => "created_at_ms ASC, id ASC",
            QuerySort::Name => "title COLLATE NOCASE ASC, created_at_ms DESC, id ASC",
            QuerySort::Largest => "size_bytes DESC, created_at_ms DESC, id ASC",
        };
        // limit/offset are `u32`, so inlining them can't inject — and it
        // keeps the positional args aligned with the count query above.
        let limit_sql = match q.limit {
            Some(n) => format!("LIMIT {n} OFFSET {}", q.offset),
            None if q.offset > 0 => format!("LIMIT -1 OFFSET {}", q.offset),
            None => String::new(),
        };

        let sql =
            format!("SELECT {ROW_COLUMNS} FROM entries {where_sql} ORDER BY {order} {limit_sql}");
        let mut stmt = conn.prepare(&sql).map_err(sql_err("prepare query"))?;
        let mapped = stmt
            .query_map(params_from_iter(args.iter()), read_row)
            .map_err(sql_err("run query"))?;
        let mut items = Vec::new();
        for row in mapped {
            items.push(row.map_err(sql_err("read query row"))?);
        }

        Ok(QueryPage {
            items,
            total: total.max(0) as u64,
        })
    }

    /// Every count the destination rail shows, as aggregates over the
    /// whole library (performance roadmap P5).
    ///
    /// Four statements rather than one: the kind breakdown and the tag
    /// breakdown are `GROUP BY`s at different grains (one row per capture
    /// vs. one row per capture-tag pair), and the scalar counts are
    /// conditional sums over a single pass. Joining them into one query
    /// would need a cross join whose cost is the product of the two
    /// groupings, to save two statements over an already-open connection.
    ///
    /// See [`LibraryFacets`] for why none of this is narrowed by the
    /// caller's active scope.
    pub fn facets(&self, q: &FacetsQuery) -> AppResult<LibraryFacets> {
        let conn = self.conn()?;

        // Scalars in one pass over the table. `trashed` is the only count
        // taken over the deleted half; everything else is live-only.
        let (total, trashed, favorites, this_week, last_30_days, large, untagged) = conn
            .query_row(
                "SELECT
                     COALESCE(SUM(trashed = 0), 0),
                     COALESCE(SUM(trashed = 1), 0),
                     COALESCE(SUM(trashed = 0 AND favorite = 1), 0),
                     COALESCE(SUM(trashed = 0 AND created_at_ms >= ?1), 0),
                     COALESCE(SUM(trashed = 0 AND created_at_ms >= ?2), 0),
                     COALESCE(SUM(trashed = 0 AND size_bytes >= ?3), 0),
                     COALESCE(SUM(trashed = 0 AND (tags IS NULL OR json_array_length(tags) = 0)), 0)
                 FROM entries",
                params![
                    q.this_week_since_ms,
                    q.last_30_days_since_ms,
                    q.large_min_bytes
                ],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                },
            )
            .map_err(sql_err("facet counts"))?;

        let mut kinds: HashMap<CaptureKind, u64> = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT kind, COUNT(*) FROM entries WHERE trashed = 0 GROUP BY kind")
                .map_err(sql_err("prepare kind facets"))?;
            let mapped = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(sql_err("query kind facets"))?;
            for row in mapped {
                let (kind, count) = row.map_err(sql_err("read kind facet"))?;
                *kinds.entry(kind_from_text(&kind)).or_insert(0) += count.max(0) as u64;
            }
        }

        // `json_each` explodes the tags array so the vocabulary is a
        // GROUP BY rather than a scan the caller folds itself. Counted
        // DISTINCT by id, and grouped on the folded spelling, so a row
        // carrying two spellings of one tag still counts once.
        let mut tags = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT lower(je.value) AS folded,
                            MIN(je.value)   AS display,
                            COUNT(DISTINCT e.id)
                       FROM entries e, json_each(e.tags) je
                      WHERE e.trashed = 0
                      GROUP BY folded
                      ORDER BY folded ASC",
                )
                .map_err(sql_err("prepare tag facets"))?;
            let mapped = stmt
                .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                .map_err(sql_err("query tag facets"))?;
            for row in mapped {
                let (tag, count) = row.map_err(sql_err("read tag facet"))?;
                tags.push(TagCount {
                    tag,
                    count: count.max(0) as u64,
                });
            }
        }

        Ok(LibraryFacets {
            total: total.max(0) as u64,
            kinds,
            favorites: favorites.max(0) as u64,
            trashed: trashed.max(0) as u64,
            tags,
            smart: SmartCounts {
                this_week: this_week.max(0) as u64,
                last_30_days: last_30_days.max(0) as u64,
                large: large.max(0) as u64,
                untagged: untagged.max(0) as u64,
            },
        })
    }

    /// Empty the index. The next reconcile refills it from disk — this
    /// is what "rebuildable at any time" costs.
    pub fn clear(&self) -> AppResult<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM entries", [])
            .map(|_| ())
            .map_err(sql_err("clear"))
    }

    /// How many rows are cached. Diagnostics and the reindex command's
    /// return value — the listing never asks, because it reconciles
    /// first. Deliberately not `len`: this is a count of what a cache
    /// happens to hold, not the size of a collection you can iterate.
    pub fn row_count(&self) -> AppResult<u64> {
        let conn = self.conn()?;
        conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get::<_, i64>(0))
            .map(|n| n.max(0) as u64)
            .map_err(sql_err("count"))
    }
}

// -------- Schema --------

/// Bring `conn` to [`SCHEMA_VERSION`], dropping an older table rather
/// than migrating it. Nothing here is authoritative, so a migration
/// would be work to preserve data the filesystem still has.
fn ensure_schema(conn: &Connection) -> AppResult<()> {
    let version: i64 = conn
        .query_row("SELECT * FROM pragma_user_version", [], |r| r.get(0))
        .optional()
        .map_err(sql_err("read user_version"))?
        .unwrap_or(0);
    if version != SCHEMA_VERSION {
        conn.execute_batch("DROP TABLE IF EXISTS entries")
            .map_err(sql_err("drop stale table"))?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS entries (
             id             TEXT PRIMARY KEY,
             title          TEXT NOT NULL,
             kind           TEXT NOT NULL,
             created_at_ms  INTEGER NOT NULL,
             size_bytes     INTEGER NOT NULL,
             trashed        INTEGER NOT NULL,
             source_app     TEXT,
             source_window  TEXT,
             mode           TEXT,
             width          INTEGER,
             height         INTEGER,
             monitor        TEXT,
             preset         TEXT,
             text           TEXT,
             swatches       TEXT,
             tags           TEXT,
             favorite       INTEGER NOT NULL DEFAULT 0,
             stamp_mtime_ms INTEGER NOT NULL,
             stamp_size     INTEGER NOT NULL,
             stamp_meta_ms  INTEGER NOT NULL,
             stamp_labels_ms INTEGER NOT NULL DEFAULT 0,
             search_blob    TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS entries_created_at
             ON entries (created_at_ms DESC, id ASC);
         -- Facet filters the grid ANDs onto the created-at order. Kept as
         -- partial-ish covering helpers for the common WHERE clauses so a
         -- filtered page stays a range scan, not a table scan.
         CREATE INDEX IF NOT EXISTS entries_kind
             ON entries (kind, created_at_ms DESC, id ASC);
         CREATE INDEX IF NOT EXISTS entries_favorite
             ON entries (favorite, created_at_ms DESC, id ASC);",
    )
    .map_err(sql_err("create schema"))?;
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(sql_err("write user_version"))
}

// -------- Row mapping --------

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CaptureMeta> {
    let swatches: Option<String> = row.get(14)?;
    let swatches = swatches
        .as_deref()
        .and_then(|s| serde_json::from_str::<Swatches>(s).ok())
        .unwrap_or_default();
    let tags: Option<String> = row.get(15)?;
    Ok(CaptureMeta {
        color: swatches.color,
        palette: swatches.palette,
        text: row.get(13)?,
        tags: tags
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default(),
        favorite: row.get::<_, i64>(16)? != 0,
        source_app: row.get(6)?,
        source_window: row.get(7)?,
        mode: row.get(8)?,
        width: row.get::<_, Option<i64>>(9)?.map(|n| n as u32),
        height: row.get::<_, Option<i64>>(10)?.map(|n| n as u32),
        monitor: row.get(11)?,
        preset: row.get(12)?,
        ..CaptureMeta::new(
            row.get(0)?,
            row.get(1)?,
            kind_from_text(&row.get::<_, String>(2)?),
            row.get::<_, i64>(3)?.max(0) as u128,
            row.get::<_, i64>(4)?.max(0) as u64,
            row.get::<_, i64>(5)? != 0,
        )
    })
}

/// The kind's column spelling *is* its wire spelling — taken through
/// serde rather than a second lookup table, so the two cannot drift.
fn kind_to_text(kind: CaptureKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "image".into())
}

/// Inverse of [`kind_to_text`]. An unreadable kind falls back to
/// `Image`, matching `library::kind_of`'s treatment of an unknown
/// extension — a row that lists as the wrong icon beats a row that
/// doesn't list.
fn kind_from_text(text: &str) -> CaptureKind {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).unwrap_or(CaptureKind::Image)
}

/// Tags as a JSON array, or `NULL` for none — so an untagged row costs
/// a null rather than the two bytes of `[]` on every capture in the
/// library.
fn tags_to_json(tags: &[String]) -> Option<String> {
    if tags.is_empty() {
        return None;
    }
    serde_json::to_string(tags).ok()
}

/// The lowercased, newline-joined haystack a text search runs against —
/// the same fields the frontend `matchesSearch` scans (title, provenance,
/// grabbed text, tags and every swatch hex), precomputed once at write
/// time so a search is one indexed column scan instead of re-deriving the
/// haystack for 50k rows on every keystroke. Newline-joined so a needle
/// can't accidentally bridge two fields. Lowercased in Rust for full
/// Unicode folding (SQLite's `lower()` is ASCII-only).
fn search_blob(meta: &CaptureMeta) -> String {
    let mut parts: Vec<&str> = vec![meta.title.as_str()];
    for v in [
        &meta.source_app,
        &meta.source_window,
        &meta.mode,
        &meta.text,
    ]
    .into_iter()
    .flatten()
    {
        parts.push(v.as_str());
    }
    for tag in &meta.tags {
        parts.push(tag.as_str());
    }
    if let Some(color) = &meta.color {
        parts.push(color.hex.as_str());
    }
    if let Some(palette) = &meta.palette {
        for swatch in palette {
            parts.push(swatch.hex.as_str());
        }
    }
    parts.join("\n").to_lowercase()
}

/// Escape a `LIKE` needle so a user typing `%` or `_` searches for those
/// literals rather than wildcards. Paired with `ESCAPE '\'` at the call
/// site; the backslash itself is escaped first so it stays literal too.
fn escape_like(needle: &str) -> String {
    needle
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn swatches_to_json(meta: &CaptureMeta) -> Option<String> {
    if meta.color.is_none() && meta.palette.is_none() {
        return None;
    }
    serde_json::to_string(&Swatches {
        color: meta.color.clone(),
        palette: meta.palette.clone(),
    })
    .ok()
}

/// SQLite integers are signed 64-bit; epoch milliseconds fit for the
/// next quarter-billion years, so the clamp is a formality that keeps
/// a nonsense value from wrapping into a negative timestamp.
fn clamp_ms(ms: u128) -> i64 {
    ms.min(i64::MAX as u128) as i64
}

fn clamp_u64(n: u64) -> i64 {
    n.min(i64::MAX as u64) as i64
}

fn sql_err(what: &'static str) -> impl Fn(rusqlite::Error) -> AppError {
    move |e| AppError::Library(format!("index {what}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    static NONCE: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> TempDir {
        let n = NONCE.fetch_add(1, Ordering::Relaxed);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("clippity-index-{ts}-{n}"));
        fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn stamp(n: i64) -> Stamp {
        Stamp {
            mtime_ms: n,
            size_bytes: n * 2,
            meta_ms: n * 3,
            labels_ms: n * 4,
        }
    }

    fn row(id: &str, created_at_ms: u128, trashed: bool) -> CaptureMeta {
        CaptureMeta::new(
            id.into(),
            "Shot".into(),
            CaptureKind::Image,
            created_at_ms,
            1024,
            trashed,
        )
    }

    #[test]
    fn an_empty_index_has_no_rows() {
        let index = LibraryIndex::in_memory().unwrap();
        assert!(index.rows(true).unwrap().is_empty());
        assert_eq!(index.row_count().unwrap(), 0);
        assert!(index.stamps().unwrap().is_empty());
    }

    #[test]
    fn put_then_read_round_trips_every_column() {
        let index = LibraryIndex::in_memory().unwrap();
        let meta = CaptureMeta {
            source_app: Some("Chrome".into()),
            source_window: Some("GitHub - Chrome".into()),
            mode: Some("Region".into()),
            width: Some(1920),
            height: Some(1080),
            monitor: Some("Display 2".into()),
            preset: Some("Docs shot".into()),
            ..row("/caps/Shot.png", 1_700_000_000_000, false)
        };
        index.put(&[(meta, stamp(7))]).unwrap();

        let back = index.rows(false).unwrap();
        assert_eq!(back.len(), 1);
        let r = &back[0];
        assert_eq!(r.id, "/caps/Shot.png");
        assert_eq!(r.title, "Shot");
        assert_eq!(r.kind, CaptureKind::Image);
        assert_eq!(r.created_at_ms, 1_700_000_000_000);
        assert_eq!(r.size_bytes, 1024);
        assert!(!r.trashed);
        assert_eq!(r.source_app.as_deref(), Some("Chrome"));
        assert_eq!(r.source_window.as_deref(), Some("GitHub - Chrome"));
        assert_eq!(r.mode.as_deref(), Some("Region"));
        assert_eq!((r.width, r.height), (Some(1920), Some(1080)));
        assert_eq!(r.monitor.as_deref(), Some("Display 2"));
        assert_eq!(r.preset.as_deref(), Some("Docs shot"));
    }

    #[test]
    fn a_row_without_provenance_reads_back_absent_not_blank() {
        // Pre-sidecar captures must survive the round trip as "nothing
        // to say", not as empty strings the UI would then render.
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[(row("/caps/Legacy.png", 5, false), stamp(1))])
            .unwrap();
        let r = &index.rows(false).unwrap()[0];
        assert_eq!(r.source_app, None);
        assert_eq!(r.mode, None);
        assert_eq!(r.width, None);
        assert_eq!(r.preset, None);
        assert_eq!(r.text, None);
        assert_eq!(r.color, None);
    }

    #[test]
    fn labels_survive_the_round_trip() {
        let index = LibraryIndex::in_memory().unwrap();
        let meta = CaptureMeta {
            tags: vec!["bug".into(), "docs".into()],
            favorite: true,
            ..row("/caps/Tagged.png", 1, false)
        };
        index.put(&[(meta, stamp(3))]).unwrap();
        let r = &index.rows(false).unwrap()[0];
        assert_eq!(r.tags, vec!["bug".to_string(), "docs".to_string()]);
        assert!(r.favorite);
    }

    #[test]
    fn an_untagged_row_reads_back_empty_rather_than_null() {
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[(row("/caps/Bare.png", 1, false), stamp(1))])
            .unwrap();
        let r = &index.rows(false).unwrap()[0];
        assert!(r.tags.is_empty());
        assert!(!r.favorite);
    }

    #[test]
    fn the_labels_stamp_is_part_of_what_makes_a_row_stale() {
        // Tagging a capture touches only its `.labels` record; if that
        // mtime weren't stamped, the cached row would never rebuild.
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[(row("/caps/A.png", 1, false), stamp(1))])
            .unwrap();
        let mut moved = stamp(1);
        moved.labels_ms += 1;
        assert_ne!(index.stamps().unwrap()["/caps/A.png"], moved);
    }

    #[test]
    fn aux_payloads_survive_the_json_column() {
        let index = LibraryIndex::in_memory().unwrap();
        let color = AuxColor {
            hex: "#1199FF".into(),
            r: 0x11,
            g: 0x99,
            b: 0xFF,
            proportion: Some(0.25),
        };
        let entry = CaptureMeta {
            color: Some(color.clone()),
            palette: Some(vec![color.clone()]),
            text: Some("hello world".into()),
            ..CaptureMeta::new(
                "aux_color_1".into(),
                "#1199FF".into(),
                CaptureKind::Color,
                9,
                0,
                false,
            )
        };
        index.put(&[(entry, stamp(2))]).unwrap();
        let r = &index.rows(false).unwrap()[0];
        assert_eq!(r.kind, CaptureKind::Color);
        assert_eq!(r.color, Some(color.clone()));
        assert_eq!(r.palette, Some(vec![color]));
        // Text is a column, not part of the JSON blob — Library P3
        // searches it.
        assert_eq!(r.text.as_deref(), Some("hello world"));
    }

    #[test]
    fn every_kind_survives_the_column_spelling() {
        // The column takes the serde spelling, so a new variant can't
        // silently become "image" on the way back.
        let index = LibraryIndex::in_memory().unwrap();
        let kinds = [
            CaptureKind::Image,
            CaptureKind::Video,
            CaptureKind::Gif,
            CaptureKind::Color,
            CaptureKind::Palette,
            CaptureKind::Text,
        ];
        let rows: Vec<_> = kinds
            .iter()
            .enumerate()
            .map(|(i, kind)| {
                (
                    CaptureMeta::new(format!("/caps/{i}"), "t".into(), *kind, i as u128, 0, false),
                    stamp(i as i64),
                )
            })
            .collect();
        index.put(&rows).unwrap();
        let back = index.rows(true).unwrap();
        let mut seen: Vec<CaptureKind> = back.iter().map(|r| r.kind).collect();
        seen.sort_by_key(|k| format!("{k:?}"));
        let mut expected = kinds.to_vec();
        expected.sort_by_key(|k| format!("{k:?}"));
        assert_eq!(seen, expected);
    }

    #[test]
    fn put_replaces_a_row_with_the_same_id() {
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[(row("/caps/A.png", 1, false), stamp(1))])
            .unwrap();
        index
            .put(&[(row("/caps/A.png", 2, true), stamp(9))])
            .unwrap();
        assert_eq!(index.row_count().unwrap(), 1);
        let r = &index.rows(true).unwrap()[0];
        assert_eq!(r.created_at_ms, 2);
        assert!(r.trashed);
        assert_eq!(index.stamps().unwrap()["/caps/A.png"], stamp(9));
    }

    #[test]
    fn rows_are_newest_first_and_ties_break_on_id() {
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[
                (row("/caps/B.png", 100, false), stamp(1)),
                (row("/caps/A.png", 100, false), stamp(1)),
                (row("/caps/C.png", 200, false), stamp(1)),
            ])
            .unwrap();
        let ids: Vec<_> = index
            .rows(false)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, ["/caps/C.png", "/caps/A.png", "/caps/B.png"]);
    }

    #[test]
    fn trashed_rows_are_hidden_unless_asked_for() {
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[
                (row("/caps/Active.png", 2, false), stamp(1)),
                (row("/caps/.trash/Gone.png", 1, true), stamp(1)),
            ])
            .unwrap();
        assert_eq!(index.rows(false).unwrap().len(), 1);
        assert_eq!(index.rows(true).unwrap().len(), 2);
    }

    #[test]
    fn remove_drops_only_the_named_rows() {
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[
                (row("/caps/A.png", 1, false), stamp(1)),
                (row("/caps/B.png", 2, false), stamp(1)),
            ])
            .unwrap();
        index.remove(&["/caps/A.png".to_string()]).unwrap();
        let ids: Vec<_> = index
            .rows(true)
            .unwrap()
            .into_iter()
            .map(|r| r.id)
            .collect();
        assert_eq!(ids, ["/caps/B.png"]);
        // Removing something absent is not an error — the reconcile
        // computes its delete list from a snapshot that may have moved.
        index.remove(&["/caps/Nope.png".to_string()]).unwrap();
    }

    #[test]
    fn empty_put_and_remove_are_no_ops() {
        let index = LibraryIndex::in_memory().unwrap();
        index.put(&[]).unwrap();
        index.remove(&[]).unwrap();
        assert_eq!(index.row_count().unwrap(), 0);
    }

    #[test]
    fn clear_empties_the_cache() {
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[(row("/caps/A.png", 1, false), stamp(1))])
            .unwrap();
        index.clear().unwrap();
        assert_eq!(index.row_count().unwrap(), 0);
        assert!(index.stamps().unwrap().is_empty());
    }

    #[test]
    fn rows_persist_across_reopen() {
        let t = temp_dir();
        let db = t.0.join(DB_FILE_NAME);
        {
            let index = LibraryIndex::open(&db).unwrap();
            index
                .put(&[(row("/caps/A.png", 1, false), stamp(4))])
                .unwrap();
        }
        let reopened = LibraryIndex::open(&db).unwrap();
        assert_eq!(reopened.row_count().unwrap(), 1);
        assert_eq!(reopened.stamps().unwrap()["/caps/A.png"], stamp(4));
    }

    #[test]
    fn open_creates_the_parent_directory() {
        let t = temp_dir();
        let db = t.0.join("nested").join(DB_FILE_NAME);
        LibraryIndex::open(&db).unwrap();
        assert!(db.exists());
    }

    #[test]
    fn a_corrupt_database_is_thrown_away_and_recreated() {
        // The whole point of a cache: garbage on disk costs a rebuild,
        // not a broken library.
        let t = temp_dir();
        let db = t.0.join(DB_FILE_NAME);
        fs::write(&db, b"this is not a database").unwrap();
        let index = LibraryIndex::open(&db).expect("recreated");
        index
            .put(&[(row("/caps/A.png", 1, false), stamp(1))])
            .unwrap();
        assert_eq!(index.row_count().unwrap(), 1);
    }

    #[test]
    fn a_stale_schema_version_drops_the_old_table() {
        let t = temp_dir();
        let db = t.0.join(DB_FILE_NAME);
        {
            let index = LibraryIndex::open(&db).unwrap();
            index
                .put(&[(row("/caps/A.png", 1, false), stamp(1))])
                .unwrap();
            // Pretend the row was written by a future schema.
            let conn = index.conn().unwrap();
            conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
                .unwrap();
        }
        let reopened = LibraryIndex::open(&db).unwrap();
        assert_eq!(
            reopened.row_count().unwrap(),
            0,
            "a version mismatch rebuilds rather than migrates"
        );
    }

    // -------- query (P5 pushdown) --------

    /// A row of `kind`, favorited or not, tagged and text as given.
    fn rich_row(
        id: &str,
        created: u128,
        kind: CaptureKind,
        favorite: bool,
        tags: &[&str],
        text: Option<&str>,
    ) -> CaptureMeta {
        CaptureMeta {
            kind,
            favorite,
            tags: tags.iter().map(|s| s.to_string()).collect(),
            text: text.map(str::to_string),
            ..row(id, created, false)
        }
    }

    fn seed_mixed(index: &LibraryIndex) {
        let rows = vec![
            (
                rich_row("/c/a.png", 100, CaptureKind::Image, true, &["bug"], None),
                stamp(1),
            ),
            (
                rich_row("/c/b.png", 200, CaptureKind::Video, false, &["Work"], None),
                stamp(2),
            ),
            (
                rich_row(
                    "/c/c.png",
                    300,
                    CaptureKind::Image,
                    false,
                    &[],
                    Some("invoice total"),
                ),
                stamp(3),
            ),
            (
                rich_row(
                    "/c/d.png",
                    400,
                    CaptureKind::Gif,
                    true,
                    &["bug", "work"],
                    None,
                ),
                stamp(4),
            ),
        ];
        index.put(&rows).unwrap();
    }

    #[test]
    fn query_default_returns_everything_newest_first() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_mixed(&index);
        let page = index.query(&LibraryQuery::default()).unwrap();
        assert_eq!(page.total, 4);
        let ids: Vec<_> = page.items.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["/c/d.png", "/c/c.png", "/c/b.png", "/c/a.png"]);
    }

    #[test]
    fn query_paginates_and_reports_full_total() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_mixed(&index);
        let page = index
            .query(&LibraryQuery {
                limit: Some(2),
                offset: 1,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.total, 4, "total is the match count, not the page size");
        let ids: Vec<_> = page.items.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["/c/c.png", "/c/b.png"]);
    }

    #[test]
    fn query_filters_by_kind_favorite_and_tag() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_mixed(&index);

        let images = index
            .query(&LibraryQuery {
                kind: Some(CaptureKind::Image),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(images.total, 2);

        let favs = index
            .query(&LibraryQuery {
                favorites_only: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(favs.total, 2);

        // Tag match is case-insensitive: "work" hits both "Work" and "work".
        let work = index
            .query(&LibraryQuery {
                tag: Some("work".into()),
                ..Default::default()
            })
            .unwrap();
        let work_ids: Vec<_> = work.items.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(work_ids, ["/c/d.png", "/c/b.png"]);
    }

    #[test]
    fn query_filters_are_anded_together() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_mixed(&index);
        let page = index
            .query(&LibraryQuery {
                favorites_only: true,
                tag: Some("bug".into()),
                ..Default::default()
            })
            .unwrap();
        let ids: Vec<_> = page.items.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["/c/d.png", "/c/a.png"], "starred AND tagged bug");
    }

    #[test]
    fn query_search_spans_text_and_tags_case_insensitively() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_mixed(&index);

        let by_text = index
            .query(&LibraryQuery {
                search: Some("INVOICE".into()),
                ..Default::default()
            })
            .unwrap();
        let text_ids: Vec<_> = by_text.items.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(text_ids, ["/c/c.png"]);

        let by_tag = index
            .query(&LibraryQuery {
                search: Some("bug".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_tag.total, 2);
    }

    #[test]
    fn query_search_finds_a_swatch_hex() {
        let index = LibraryIndex::in_memory().unwrap();
        let meta = CaptureMeta {
            color: Some(AuxColor {
                hex: "#FF6E4A".into(),
                r: 255,
                g: 110,
                b: 74,
                proportion: None,
            }),
            ..row("/c/color.png", 500, false)
        };
        index.put(&[(meta, stamp(9))]).unwrap();
        let hit = index
            .query(&LibraryQuery {
                search: Some("#ff6e4a".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(hit.total, 1, "a palette is findable by any of its swatches");
    }

    #[test]
    fn query_search_treats_wildcards_as_literals() {
        let index = LibraryIndex::in_memory().unwrap();
        let plain = CaptureMeta {
            text: Some("abcd".into()),
            ..row("/c/plain.png", 10, false)
        };
        let pct = CaptureMeta {
            text: Some("50% off".into()),
            ..row("/c/pct.png", 20, false)
        };
        index.put(&[(plain, stamp(1)), (pct, stamp(2))]).unwrap();
        let page = index
            .query(&LibraryQuery {
                search: Some("50%".into()),
                ..Default::default()
            })
            .unwrap();
        let ids: Vec<_> = page.items.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["/c/pct.png"], "'%' is a literal, not a wildcard");
    }

    #[test]
    fn query_trash_view_is_separate() {
        let index = LibraryIndex::in_memory().unwrap();
        index
            .put(&[
                (row("/c/live.png", 1, false), stamp(1)),
                (row("/c/dead.png", 2, true), stamp(2)),
            ])
            .unwrap();
        let live = index.query(&LibraryQuery::default()).unwrap();
        assert_eq!(live.total, 1);
        assert_eq!(live.items[0].id, "/c/live.png");
        let both = index
            .query(&LibraryQuery {
                trash: TrashFilter::Include,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(both.total, 2, "Include widens to the whole set");

        let trash = index
            .query(&LibraryQuery {
                trash: TrashFilter::Only,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(trash.total, 1, "Only is the trash view, not a superset");
        assert_eq!(trash.items[0].id, "/c/dead.png");
    }

    #[test]
    fn query_sql_and_in_memory_paths_agree() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_mixed(&index);
        let all = index.rows(true).unwrap();
        let cases = [
            LibraryQuery::default(),
            LibraryQuery {
                kind: Some(CaptureKind::Image),
                ..Default::default()
            },
            LibraryQuery {
                favorites_only: true,
                tag: Some("bug".into()),
                ..Default::default()
            },
            LibraryQuery {
                search: Some("invoice".into()),
                ..Default::default()
            },
            LibraryQuery {
                sort: QuerySort::Oldest,
                limit: Some(2),
                offset: 1,
                ..Default::default()
            },
            LibraryQuery {
                trash: TrashFilter::Include,
                sort: QuerySort::Largest,
                ..Default::default()
            },
            LibraryQuery {
                trash: TrashFilter::Only,
                ..Default::default()
            },
        ];
        for q in cases {
            let sql = index.query(&q).unwrap();
            let mem = q.apply_in_memory(all.clone());
            assert_eq!(sql.total, mem.total, "total mismatch for {q:?}");
            let sql_ids: Vec<_> = sql.items.iter().map(|m| &m.id).collect();
            let mem_ids: Vec<_> = mem.items.iter().map(|m| &m.id).collect();
            assert_eq!(sql_ids, mem_ids, "page mismatch for {q:?}");
        }
    }

    #[test]
    fn query_sorts_by_name_and_size() {
        let index = LibraryIndex::in_memory().unwrap();
        let big = CaptureMeta {
            title: "alpha".into(),
            size_bytes: 9_000,
            ..row("/c/1.png", 1, false)
        };
        let small = CaptureMeta {
            title: "Beta".into(),
            size_bytes: 10,
            ..row("/c/2.png", 2, false)
        };
        index.put(&[(big, stamp(1)), (small, stamp(2))]).unwrap();

        let by_name = index
            .query(&LibraryQuery {
                sort: QuerySort::Name,
                ..Default::default()
            })
            .unwrap();
        let names: Vec<_> = by_name.items.iter().map(|m| m.title.as_str()).collect();
        assert_eq!(names, ["alpha", "Beta"], "NOCASE: alpha before Beta");

        let by_size = index
            .query(&LibraryQuery {
                sort: QuerySort::Largest,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(by_size.items[0].title, "alpha", "largest first");
    }

    // -------- facets (P5 rail aggregates) --------

    /// Thresholds that put every `seed_facets` row in both time windows,
    /// so a test that isn't about the windows doesn't accidentally depend
    /// on them.
    fn wide_facets() -> FacetsQuery {
        FacetsQuery {
            this_week_since_ms: 0,
            last_30_days_since_ms: 0,
            large_min_bytes: i64::MAX,
        }
    }

    /// Four live rows + one trashed, with mixed kinds, stars and tag
    /// spellings — the shapes the rail has to fold.
    fn seed_facets(index: &LibraryIndex) {
        let rows = vec![
            (
                CaptureMeta {
                    size_bytes: 100,
                    ..rich_row("/c/a.png", 1_000, CaptureKind::Image, true, &["bug"], None)
                },
                stamp(1),
            ),
            (
                CaptureMeta {
                    size_bytes: 9_000,
                    ..rich_row(
                        "/c/b.png",
                        2_000,
                        CaptureKind::Video,
                        false,
                        &["Bug", "work"],
                        None,
                    )
                },
                stamp(2),
            ),
            (
                CaptureMeta {
                    size_bytes: 50,
                    ..rich_row("/c/c.png", 3_000, CaptureKind::Image, true, &[], None)
                },
                stamp(3),
            ),
            (
                CaptureMeta {
                    size_bytes: 70,
                    ..rich_row("/c/d.png", 4_000, CaptureKind::Image, false, &[], None)
                },
                stamp(4),
            ),
            (
                CaptureMeta {
                    trashed: true,
                    tags: vec!["bug".into()],
                    favorite: true,
                    ..row("/c/gone.png", 5_000, true)
                },
                stamp(5),
            ),
        ];
        index.put(&rows).unwrap();
    }

    #[test]
    fn facets_count_kinds_favorites_and_trash_over_live_rows() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_facets(&index);
        let f = index.facets(&wide_facets()).unwrap();

        assert_eq!(f.total, 4, "total excludes the trashed row");
        assert_eq!(f.trashed, 1);
        assert_eq!(f.kinds.get(&CaptureKind::Image), Some(&3));
        assert_eq!(f.kinds.get(&CaptureKind::Video), Some(&1));
        assert_eq!(f.kinds.get(&CaptureKind::Gif), None, "absent, not zero");
        assert_eq!(
            f.favorites, 2,
            "the trashed row is starred but must not be counted"
        );
    }

    #[test]
    fn facets_fold_tag_spellings_and_order_them() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_facets(&index);
        let f = index.facets(&wide_facets()).unwrap();

        let tags: Vec<(&str, u64)> = f.tags.iter().map(|t| (t.tag.as_str(), t.count)).collect();
        // `bug` and `Bug` are one tag carried by two live captures; the
        // trashed row's `bug` is not counted.
        assert_eq!(tags, [("Bug", 2), ("work", 1)]);
    }

    #[test]
    fn facets_cut_the_derived_sets_at_the_callers_thresholds() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_facets(&index);
        let f = index
            .facets(&FacetsQuery {
                this_week_since_ms: 3_000,
                last_30_days_since_ms: 2_000,
                large_min_bytes: 1_000,
            })
            .unwrap();

        assert_eq!(f.smart.this_week, 2, "created_at >= 3000, live only");
        assert_eq!(f.smart.last_30_days, 3);
        assert_eq!(f.smart.large, 1, "only the 9k row clears 1k");
        assert_eq!(f.smart.untagged, 2);
    }

    #[test]
    fn facets_of_an_empty_library_are_all_zero() {
        let index = LibraryIndex::in_memory().unwrap();
        let f = index.facets(&wide_facets()).unwrap();
        assert_eq!(f.total, 0);
        assert_eq!(f.trashed, 0);
        assert_eq!(f.favorites, 0);
        assert!(f.kinds.is_empty());
        assert!(f.tags.is_empty());
        assert_eq!(f.smart.untagged, 0);
    }

    #[test]
    fn facets_sql_and_in_memory_paths_agree() {
        let index = LibraryIndex::in_memory().unwrap();
        seed_facets(&index);
        let all = index.rows(true).unwrap();
        let cases = [
            wide_facets(),
            FacetsQuery {
                this_week_since_ms: 3_000,
                last_30_days_since_ms: 2_000,
                large_min_bytes: 1_000,
            },
            FacetsQuery {
                this_week_since_ms: i64::MAX,
                last_30_days_since_ms: i64::MAX,
                large_min_bytes: 0,
            },
        ];
        for q in cases {
            let sql = index.facets(&q).unwrap();
            let mem = q.apply_in_memory(&all);
            assert_eq!(sql.total, mem.total, "total mismatch for {q:?}");
            assert_eq!(sql.trashed, mem.trashed, "trashed mismatch for {q:?}");
            assert_eq!(sql.favorites, mem.favorites, "favorites mismatch for {q:?}");
            assert_eq!(sql.kinds, mem.kinds, "kinds mismatch for {q:?}");
            let sql_tags: Vec<_> = sql.tags.iter().map(|t| (&t.tag, t.count)).collect();
            let mem_tags: Vec<_> = mem.tags.iter().map(|t| (&t.tag, t.count)).collect();
            assert_eq!(sql_tags, mem_tags, "tags mismatch for {q:?}");
            assert_eq!(
                (
                    sql.smart.this_week,
                    sql.smart.last_30_days,
                    sql.smart.large,
                    sql.smart.untagged
                ),
                (
                    mem.smart.this_week,
                    mem.smart.last_30_days,
                    mem.smart.large,
                    mem.smart.untagged
                ),
                "smart mismatch for {q:?}"
            );
        }
    }
}
