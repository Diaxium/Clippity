# 0028 — The library index is a SQLite cache, reconciled before every read

- **Status:** Accepted (implemented)
- **Date:** 2026-07-21
- **Area:** `app/backend/src/services/{library_index.rs,library_service.rs,mod.rs}`,
  `app/backend/src/app/{state.rs,commands.rs}`, `app/backend/src/lib.rs`,
  `app/backend/Cargo.toml`,
  `app/frontend/src/services/tauri/clients/library.ts`
- **Relates to:** [0026 — capture provenance is a sidecar](0026-capture-provenance-is-a-sidecar-written-at-the-save-choke-point.md)
  (the rows this caches), [0027 — monitor + preset](0027-monitor-is-attributed-preset-is-declared.md)
  (the last two columns), [0006 — aux catalog](README.md) (the other family of
  rows), [library-organization](../roadmaps/library-organization.md) **Phase 1**
  (completes it), Phase 3 filters/search and Phase 4 smart collections (what it
  unblocks)

## Context

[Library Phase 1](../roadmaps/library-organization.md) named three pieces:
capture-time metadata, an index over it, and a backfill. ADR 0026 + 0027
delivered the metadata — every capture now carries a `.meta` provenance record
beside it. The index was the remaining half, and the roadmap had already fixed
its shape: *"rebuildable from disk at any time (the filesystem stays the source
of truth; the index is a cache)"*, with a column list that is exactly
`CaptureMetadata`'s fields.

Two costs made it worth building now rather than later.

**Listing pays per capture.** `library_service::list` walked the captures dir
and, for every file, opened and JSON-parsed its `.meta` sidecar. That is N file
reads to render a screen that mostly hasn't changed since the last one — and it
is the cost that grows with a library, which is precisely the axis
[Performance P3](../roadmaps/performance.md) worries about.

**Filtering has nowhere to run.** Phase 3's filter bar (date, kind, app, mode,
monitor, preset) and Phase 4's smart collections are `WHERE` clauses over data
that, until now, only existed as a directory full of small JSON files. Without a
queryable surface, every filter would be a full rescan in Rust.

The thing to get right was not the schema — the roadmap had settled that — but
the **relationship between the cache and the disk**. A cache that can be wrong is
worse than no cache, because "the filesystem is the source of truth" stops being
a property of the system and becomes a maintenance instruction.

## Decision

**The index is a SQLite database that is reconciled against the filesystem
before every read.** It is never queried without first being made true.

Reconciliation is driven by a **stamp** — the capture file's mtime and size, plus
its `.meta` record's mtime. On each listing:

- every capture in `<captures>/` and `<captures>/.trash/` is `stat`ed;
- a row whose stamp still matches is served from SQLite untouched;
- a row whose stamp moved is rebuilt from disk (the sidecar read the scan always
  did);
- a row whose file is no longer there is deleted.

So the index cannot serve an answer the filesystem disagrees with, and
"rebuildable at any time" is a property of the read path rather than a command a
user has to know about. The saving is real because the *expensive* half — open,
read, parse — is what the stamp lets us skip, while the cheap half (a `stat` on a
directory entry the walk already warmed) is what pays for the guarantee.

**The sidecar's mtime is in the stamp, not just the capture's.** Provenance is
half the row, so a record rewritten without the pixels being touched has to
invalidate the row too. It costs one extra `stat` per capture and closes the only
way the cache could have described something its source no longer said.

**Both directories are walked regardless of what the caller asked to see.** The
index describes the whole library; `include_trashed` is a filter applied at query
time. Reconciling only the half being displayed would leave the other half stale
for whoever looks next.

**No index is a supported state.** If the database won't open — read-only disk,
a locked file, corruption — the service logs and lists by scanning, which is
exactly what it did before this ADR. The same fallback catches a mid-flight
failure. A cache is never allowed to be the reason a user can't see their
captures, and the whole existing library test suite now runs through the *cached*
path with the scanning path re-asserted beside it, because the two must be
indistinguishable to a caller.

**Columns for what the catalog will be searched by; JSON for what it will only be
shown with.** Every provenance field is a real column (they are all Phase 3
filter facets), and grabbed text is a real column (it is the full-text target,
and FTS5 attaches here when [Vision P4](../roadmaps/vision-ai.md) indexes the
rest of the library). The colour and palette swatches — display payloads no query
will ever key on — ride in one JSON column instead of widening the schema with
shapes nothing filters.

**Aux entries get rows; `history.json` keeps them.** This settles the roadmap's
open question "does the aux catalog merge into the same index/table space?" —
yes in the index, no in storage. Colours, palettes and grabbed text are indexed
alongside file captures so one query covers the whole library, but the catalog
file remains their home, stamped as a unit (it is one file, so it gets one
stamp). Aux entries have no file to hang a sidecar off, which is why they could
never join the ADR 0026 storage model; that argument was always about *storage*,
and it doesn't reach the query layer.

**The database lives in the app data directory**, `<data>/library.db`, beside
`settings.json` — where `infra::paths` had already reserved a spot for it. The
captures folder is the user's: it holds their files and each file's description.
An index is app machinery that a reconcile can rebuild from those at any time, so
it does not belong among the things a user might back up or sync. It also keeps
it out of `library_service::storage`'s byte count, which reports what the user's
captures cost, not what our cache does.

**A version mismatch drops the table.** `user_version` is stamped on open, and
anything else recreates the schema. There is no migration path and there
shouldn't be: migrating a cache is work spent preserving data the filesystem
still has.

### Rejected

- **A JSON index file** (the roadmap's stated alternative). Simpler to write and
  it would have skipped a C-compiled dependency — but it must be loaded and
  written whole, it gives Phase 3 nothing a `Vec` doesn't, and full-text search
  over OCR text becomes bespoke where SQLite hands it over as FTS5. The roadmap's
  own recommendation, and it survived contact.
- **Serving the index without reconciling** (write-through: update the index in
  `delete` / `restore` / `purge` and on capture, then trust it). Faster still,
  and wrong the first time anything touches the captures folder from outside the
  app — Explorer, a sync client, a script. It also spreads index-awareness across
  every call site that moves a file, which is the coupling ADR 0026 went out of
  its way to avoid for sidecars.
- **Incremental scanning via a filesystem watcher.** The right eventual answer to
  the directory walk itself, and it is already tracked as
  [Performance P3](../roadmaps/performance.md). It is orthogonal to this: a
  watcher would tell the reconcile *when* to run, not change what makes it
  correct.
- **Putting the database in the captures folder.** Attractive for
  [Library P5](../roadmaps/library-organization.md)'s multiple roots, since it
  would be per-root by construction. Rejected because it puts app plumbing in the
  user's folder and inside their backups. When P5 lands, per-root caching is a
  keying problem inside the data dir, not a reason to move the file.

## Consequences

- **Library Phase 1 is complete.** Metadata (ADR 0026/0027) and the index both
  ship; the "backfill migration" third piece is, as ADR 0026 predicted, not a
  migration at all — a capture without a record indexes exactly as it lists,
  with the provenance columns absent.
- **Phase 3 and Phase 4 are unblocked and cheap.** The filter bar is
  `WHERE source_app = ?` over columns that already exist; a smart collection is a
  stored predicate over the same. Neither needs new capture work or a new scan.
- **Listing an unchanged library costs stats instead of parses.** The win scales
  with library size, which is the direction that matters.
- **Ordering is now deterministic.** Rows sort newest-first with a tiebreak on
  id; two captures sharing a millisecond used to swap places between listings
  depending on what `read_dir` handed back. The scanning fallback sorts the same
  way, because the two paths must not disagree about anything observable.
- **`library_reindex` is a new IPC command** (and `libraryReindex` in the library
  client). Nothing in normal operation needs it — that is the point of
  reconciling on read — but "rebuildable at any time" is only a real property if
  something exercises it, and it is the repair for the one blind spot the stamp
  has: a capture rewritten within the same millisecond *and* to the same byte
  count as the row it replaced.
- **`rusqlite` (bundled SQLite) joins the dependency tree.** It compiles C, which
  needs the MSVC toolchain — already required to link a Tauri app on Windows, so
  the build bar does not move. Bundled rather than system: no runtime dependency,
  and the FTS5 build Phase 3 wants is guaranteed present rather than whatever the
  host happens to ship.
