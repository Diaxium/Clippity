# 0026 — Capture provenance is a sidecar, written once at the save choke point

- **Status:** Accepted (implemented)
- **Date:** 2026-07-21
- **Area:** `app/backend/src/domain/{metadata.rs,naming.rs,library.rs,window_attribution.rs}`,
  `app/backend/src/services/{sidecar.rs,capture_io.rs,library_service.rs,capture_service.rs,overlay_service.rs,scroll_capture_service.rs,editor_service.rs}`,
  `app/backend/src/platform/windows/enumeration.rs`,
  `app/frontend/src/services/tauri/clients/library.ts`,
  `app/frontend/src/features/library/{lib/format.ts,components/CaptureCard.tsx,components/CaptureRow.tsx}`
- **Relates to:** [0017 — editable scene save (JSON sidecar)](0017-editor-editable-save-and-grouping.md)
  (the sidecar precedent this generalizes), [0004 — capture presets](../roadmaps/capture.md)
  (a preset's pinned output folder is why sidecars are parent-relative),
  [0006 — aux catalog](README.md) (the other half of the library's storage
  model), [library-organization](../roadmaps/library-organization.md) **Phase 1**,
  [sharing-export](../roadmaps/sharing-export.md) P1 (filename templates)

## Context

Everything in [Library & organization](../roadmaps/library-organization.md)
past Phase 1 — tags, collections, filters, full-text search, smart collections
— and [Sharing](../roadmaps/sharing-export.md) P1's filename templates need
facts about a capture that the pixels don't carry: which app it came from,
which mode produced it, when it was actually taken. Phase 1 names three pieces:
capture-time metadata, an index over it, and a backfill migration. The index is
explicitly a *cache*; the metadata is the data. So the metadata comes first.

Two questions had to be answered before any of it could be written.

**Where does the record live?** The library's stated model is that the
filesystem is the source of truth. A central index file (`history.json`-style,
like the aux catalog) would immediately make that false for the new fields: copy
a capture to another machine and its provenance stays behind. It also
reintroduces a single-writer bottleneck on a path that runs on every capture.

**Who writes it?** Five call sites persist a capture today — fullscreen,
clipboard ingest, the overlay's shared finalize, scroll/panoramic stitching, and
the editor's export. Asking each to also write a record is how a sixth pipeline
ships without one.

## Decision

**Provenance is a per-capture JSON sidecar**, `<dir>/.meta/<file name>.json`,
written by `services::sidecar` — the same shape ADR 0017 already established for
the editor's `.scenes` documents, now generalized into one module that owns both
families.

**Sidecars are parent-relative, not root-relative.** A record hangs off the
directory the capture actually landed in, so it follows the capture into a
preset's pinned output folder (ADR 0004) and into `.trash/` without any of those
paths knowing sidecars exist.

**The write is hoisted into `capture_io::save_capture_image`** — the one
function every capture pipeline already funnels through. This is the same move
that put smart-enhance and the PNG encode in `overlay_service::persist_and_emit`:
every mode, *including ones added later*, records provenance by construction
rather than by remembering to.

**Naming and metadata read the same struct.** `domain::naming::render` used to
take its own `NameContext`; it now takes `domain::metadata::CaptureSource`, the
same value the record is built from, at the same clock instant. A capture's file
name and its sidecar cannot describe different origins, because there is only
one description.

Consequences that follow from the above rather than being separate decisions:

- **`domain::window_attribution` returns the whole winning window**, not just
  its title, so the recorded app and title always name the same window.
- **`library::sidecar_file_name` is shared by both families**, so a capture's
  `.meta` and `.scenes` records resolve to one name — which is what lets
  trash/restore/purge move *the set* generically. `SIDECAR_DIRNAMES` is the only
  place a future third family needs to be listed.
- **Every operation is best-effort.** A read-only output folder costs the user a
  record, never a screenshot. An unreadable or corrupt record is the same answer
  as no record.
- **The scan prefers the recorded instant over mtime** for `created_at_ms`, so
  editing or copying a capture no longer moves it in the library's timeline.

### Rejected

- **A central index file now.** It breaks "the filesystem is truth" for exactly
  the fields being added, and serializes every capture behind one writer. The
  roadmap's SQLite index remains the right Phase 1 follow-up — but as a
  *rebuildable cache over these sidecars*, which is what makes it safe to
  delete.
- **Embedding provenance in the image (EXIF/PNG text chunks).** Survives copying,
  which is genuinely better — but it is per-format (PNG text vs JPEG EXIF vs
  WebP), it means re-encoding or patching bytes the editor path deliberately
  never inspects (ADR 0018), and it can't hold anything a future phase wants to
  *edit*, like tags. Worth revisiting as an export-time enrichment, not as the
  store.
- **A friendly app name from the executable's version resource** ("Google
  Chrome" rather than "Chrome"). One `GetFileVersionInfo` round-trip per window
  on the overlay-open path, a new Win32 feature, and a string that varies by
  locale and installer. The executable stem, capitalized when it is all
  lowercase, is stable and is what users recognise.

## Consequences

- Library rows now carry `sourceApp` / `sourceWindow` / `mode` / `width` /
  `height`. All optional: captures saved before this shipped list exactly as
  before, with the columns absent — which is what makes the future backfill a
  pure improvement rather than a migration users must run.
- `{app}` joins the filename-template tokens, delivering the metadata half of
  [Sharing P1](../roadmaps/sharing-export.md).
- `WindowFrame.app` — a field that had shipped hardcoded to `""` because
  "resolving it needs process APIs not in the crate's enabled feature set" — is
  now real. Those APIs (`Win32_System_Threading`) had since been enabled for
  `GetLocalTime`/`GetCurrentProcessId`; the comment had gone stale. The overlay's
  window picker gets real app labels as a side effect.
- **A correctness fix that predates this work:** trash / restore / purge did not
  carry the editor's `.scenes` sidecar. Trashing an annotated capture and
  restoring it silently dropped the edits, and purging left the document orphaned
  forever. Both families move together now — the bug had to be fixed here anyway,
  because adding a second sidecar family without it would have doubled it.
- ~~**Not yet recorded**, and deliberately not faked: **monitor** (resolvable
  from the capture rect, but no pipeline threads one to the save call today) and
  **preset used** (presets are executed by the frontend's `runPreset`
  orchestrator, which never tells the backend which preset it is running — that
  needs an IPC field, not a metadata field).~~ **Both landed 2026-07-21** in
  [ADR 0027](0027-monitor-is-attributed-preset-is-declared.md), along the exact
  lines predicted here: the monitor by attribution over the capture rect, the
  preset as an IPC field on the request. The record is now complete, and the
  remaining Phase 1 work is the index + backfill — both caches over these
  sidecars rather than new data.
