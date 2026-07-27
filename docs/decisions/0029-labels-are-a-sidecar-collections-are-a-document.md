# 0029 — Labels ride a sidecar; a collection is a document

- **Status:** Accepted (implemented)
- **Date:** 2026-07-21
- **Area:** `app/backend/src/domain/{labels.rs,collections.rs,library.rs,mod.rs}`,
  `app/backend/src/services/{sidecar.rs,collections_service.rs,library_service.rs,library_index.rs,mod.rs}`,
  `app/backend/src/app/{state.rs,commands.rs,events.rs}`,
  `app/backend/src/lib.rs`,
  `app/frontend/src/services/tauri/{events.ts,clients/{library.ts,collections.ts,index.ts}}`,
  `app/frontend/src/features/library/**`,
  `app/frontend/src/features/tray/hooks/useRecentCaptures.ts`
- **Relates to:** [0026 — capture provenance is a sidecar](0026-capture-provenance-is-a-sidecar-written-at-the-save-choke-point.md)
  (the storage precedent this follows, and the record it declines to extend),
  [0028 — the library index is a cache](0028-library-index-is-a-cache-reconciled-before-every-read.md)
  (the stamp this adds a term to), [0017 — editable save](0017-editor-editable-save-and-grouping.md)
  (the other sidecar family), [library-organization](../roadmaps/library-organization.md)
  **Phase 2** (this is it), Phase 3 filters and Phase 4 smart collections (what
  it feeds)

## Context

[Library Phase 2](../roadmaps/library-organization.md) is tags, collections,
favorites and bulk operations. Phase 1 closed the record and built the index over
it, so the question here was never *where does this get queried* — the index
answers that — but **where does it live on disk**.

The roadmap left exactly one open question, and it had already narrowed it:

> Are tags/collections stored **only** in the index, or mirrored to sidecar files
> so they survive index loss? **Settled by precedent**: provenance ships as a
> per-capture sidecar (ADR 0026), so the index is a cache over sidecars by
> construction — and ADR 0028 made that literal by reconciling before every read.
> Tags/collections must follow the same shape or the index stops being
> disposable; the open part is only whether they extend `CaptureMetadata` or get
> their own family under `SIDECAR_DIRNAMES`.

So: not *whether* disk owns this — ADR 0028 makes that non-negotiable, since a
row that only exists in the cache dies the first time the cache is thrown away —
but *which* file on disk. And the roadmap's framing contained a hidden
assumption worth naming: it treats "tags/collections" as one question. They are
not.

There was also a live constraint from `domain::library`'s own comment, written
before any of this: tags, collections and favorites *"defer to the catalog-v2
port (which forces a stable surrogate id for file entries at the same time)"*.
That prediction is what the decision below has to either honour or dismantle.

## Decision

**Tags and the favorite flag are properties of a capture, so they ride in a
record beside it. A collection is not a property of anything, so it is its own
document.** Two different shapes of fact, two different homes.

### Labels: a third sidecar family, `.labels`

`<dir>/.labels/<file name>.json`, holding `{ version, file, tags, favorite }`
(`domain::labels::CaptureLabels`), sitting alongside `.meta` and `.scenes` under
the same parent-relative rule ADR 0026 established.

**Not an extension of `CaptureMetadata`.** The provenance record is a statement
about a moment that already happened: written once at the save choke point, never
edited. Labels are the opposite — authored afterwards and rewritten whenever the
user changes their mind. Folding them together would mean a tag edit rewrites a
record of what the machine observed, with a corrupted or partial write costing
provenance that cannot be recovered, and would move `.meta`'s mtime for reasons
having nothing to do with provenance. Two lifetimes, two files.

Adding `.labels` to `SIDECAR_DIRNAMES` is the whole of the file-op work: trash,
restore and purge already carry *every* family generically (the reason
[Library P5's sidecar-aware file ops](../roadmaps/library-organization.md) were
pulled forward). A capture's tags survive a trip through the trash because
nothing new had to be taught about them.

**Removing the last label deletes the record.** `sidecar::write_labels` unlinks
rather than writing `{}`, so a capture that was starred and unstarred is
byte-for-byte the filesystem state of one that never was — including its stamp,
which is what keeps the index from treating "no labels" and "labels removed" as
different rows.

**Aux entries carry their labels inline.** A colour or a grabbed-text entry has
no file to hang a sidecar off — the same fact that kept them out of ADR 0026 —
so their tags and star live on the `CaptureMeta` row inside `history.json`. Both
paths read back into the same two fields, so a caller cannot tell which storage a
row came from.

### Collections: `<captures>/collections.json`

An id, a name, timestamps, and **an ordered list of member capture ids**
(`domain::collections`).

The ordering is the whole argument. Tags are a set; membership-with-order is not
something a per-capture record can express, because no two captures can between
them say which of the two comes third in "Onboarding walkthrough". Storing
membership per-capture would mean either giving up manual order — turning a
collection into a saved filter, which is Phase 4's *smart* collection, a
different feature — or storing a rank per membership and rewriting N sidecars for
one drag.

It lives with the captures rather than in the app data dir because it **is** user
data: an arrangement they made, which should survive a reinstall and travel with
a backed-up captures folder. That is the same test ADR 0028 applied to reach the
opposite conclusion for `library.db` — machinery a reconcile can rebuild belongs
in the data dir; something no reconcile could ever reconstruct does not.

**The id-churn cost is paid at the choke point, not designed around.** A
file-backed capture's id is its path, and a trash move changes it.
`collections_service::rekey` runs in `LibraryService::delete` / `restore`, right
beside `sidecar::relocate` — the same two lines, in the same two places, for the
same reason. `forget` runs on purge. This is what makes the roadmap's predicted
"stable surrogate id for file entries" unnecessary for Phase 2: the churn is
already localised to two call sites that were carrying per-capture state across
an id change anyway.

**A member whose capture is missing is not pruned on sight.** Files vanish for
reasons that reverse — an unplugged drive, a folder moved and moved back — and a
collection that forgot its members every time one blinked would be worse than one
that renders a shorter list today. Membership is dropped only on purge, where the
capture is gone for good. `set_order` follows the same instinct: ids the incoming
order forgets keep their relative place at the end rather than being deleted, so
a reorder computed before another window added a capture cannot destroy it.

### The index gets two columns and the stamp gets a term

`tags` (JSON array) and `favorite` (integer) join `entries`; `Stamp` gains
`labels_ms`, and `SCHEMA_VERSION` goes to 2 — which, per ADR 0028, drops the
table and refills it from disk rather than migrating.

The stamp term is what makes tagging visible at all: a label edit touches only
the `.labels` record, so without its mtime in the stamp the cached row would
never rebuild and the new tag would not appear until something else changed the
file.

Favorite is a real column because it is a one-click filter facet. Tags are a JSON
column plus an in-memory predicate: they are a filter facet too, but a row has
many of them, and the shape SQLite wants for that is a second table and a join.
That join is [Phase 3](../roadmaps/library-organization.md) work — when a tag
filter has to be a `WHERE` clause rather than a `.filter()` — and the column is
the same either way.

### Every label command takes a list

`library_set_favorite` / `add_tags` / `remove_tags` / `set_tags` and the
collection membership commands all take id **lists**. Bulk operations — the
fourth Phase 2 bullet — therefore cost nothing: starring one capture and starring
a forty-capture selection are the same call, with no fan-out in the UI and no
second code path in the backend. Trash / restore / purge stay per-id, because
they are per-file moves with per-file failure modes; the UI fans those out with
`allSettled` so one capture another window already moved cannot abort the rest.

An edit returns **how many entries actually changed**, and a no-op edit writes
nothing and emits nothing. Re-adding a tag a capture already carries would
otherwise move the sidecar's mtime and cost the index a rebuilt row for a change
nobody made.

### `collections/updated` is its own event

Not folded into `library/updated`. A capture joining a collection changes no row
in a listing, so sharing the event would make every library view re-fetch its
whole list over an arrangement it is not showing.

## Rejected

- **Extending `CaptureMetadata` with tags + favorite.** The roadmap's other named
  option, and the one that needs no new sidecar family. Rejected on lifetime:
  see above — a write-once observation record and a user-edited annotation should
  not share a file, or every tag edit puts provenance at risk.
- **Storing tags only in the index.** Fastest to query and simplest to write.
  Rejected because ADR 0028's index is disposable by construction — dropped on a
  schema bump, deleted on corruption, rebuilt from disk on demand — so a tag that
  lived only there would be data the system is designed to throw away.
- **Collection membership per-capture (a `collections: [...]` field in
  `.labels`).** Tempting: membership would survive every file operation for free,
  with no rekey and no choke-point coupling. Rejected because it cannot hold
  order without a per-membership rank, and a rank makes one drag an N-sidecar
  rewrite. The rekey it avoids is two lines beside an existing two lines.
- **A stable surrogate id for file-backed captures**, as `domain::library`
  predicted catalog-v2 would force. It would make membership immune to path
  changes — but the id is the path in every IPC command, every thumbnail
  request, and the editor's open path, so introducing a second identity means
  a lookup table that itself has to survive the same file operations. The churn
  is real but bounded to two call sites; buying a new identity space to avoid
  two lines is the more expensive trade. Phase 5's rename will use the same two
  lines.
- **Deleting a collection's members along with it.** A collection arranges files;
  it does not hold them. Deleting one takes the arrangement, not the captures —
  which is also why deleting asks twice: the captures are recoverable and the
  curated order is not.
- **A "selection mode" toggle before multi-select.** Rejected for a plainer
  model: ticking the first checkbox starts a selection and clearing the last one
  ends it. A mode toggle adds a step before the thing the user already decided to
  do, and leaves a third state — in selection mode, nothing selected — that means
  nothing.

## Consequences

- **Library Phase 2 ships**: tags (freeform, multi, chips on cards + a filter
  row + an editor popover), collections (manual, ordered, many-to-many, with a
  rail), favorites (one-click, filterable, and **first in the tray's recent
  strip** — a starred capture outranks recency on a four-tile quick-access
  surface), and bulk operations (multi-select → tag / favorite / collect / trash).
- **Phase 3's tag and collection facets now have storage behind them**, which is
  the last thing its filter bar was missing — every other facet became a column
  in Phase 1.
- **Phase 4's smart collections have a shape to contrast with.** A collection is
  now concretely "a document with an ordered member list"; a smart collection is
  a stored predicate with no member list at all. The `CollectionCatalog` object
  wrapper leaves room for the predicate field without re-shaping the file.
- **`SIDECAR_DIRNAMES` has three entries and the file-op code did not change.**
  The generic-carry design from the Phase 1 pass paid for itself the first time
  it was tested.
- **The index rebuilds once on upgrade.** `SCHEMA_VERSION` 2 drops the v1 table;
  the next listing refills it. No user-visible step, no migration code — the
  property ADR 0028 bought.
- **Bulk export is deliberately absent** from the Phase 2 bullet's list. Where a
  batch of captures goes is [Sharing](../roadmaps/sharing-export.md)'s question —
  it needs destinations and a format, not a selection model — and the selection
  machinery here is what it will build on when it lands.
