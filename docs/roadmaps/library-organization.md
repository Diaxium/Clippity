# Library and organization roadmap

## Current state and strengths

The library already reconciles file-backed images/video/GIF plus aux colors,
palettes and text into SQLite; supports grid/list, grouping, sort, search,
favorites, trash/restore/purge, tags, manual ordered collections, smart time/
size/untagged views, provenance, inspector and batch selection. The filesystem
remains recoverable source-of-truth data.

## Gaps and opportunities

- No first-class import/open-with/watch-folder flow.
- Search does not index OCR text, window/app provenance deeply or visual meaning.
- No saved searches/rules, duplicates, similarity, versions, backup/restore,
  multi-root or storage health.
- Video/GIF categories are anticipatory; thumbnails/media metadata need a full
  pipeline.
- Sidecar-aware moves across roots/sync boundaries need transactional design.

## Delivery portfolio

| Phase | Initiative | Priority | Impact | Complexity | Prerequisites |
| --- | --- | --- | --- | --- | --- |
| L0: trust (0–8 wk) | Import, drag/drop/open-with; storage health/reindex/recovery; atomic sidecars; consistent undo for trash/tag/collection actions. | P0/P1 | High | L | Persistence/security path fixes. |
| L1: find (2–4 mo) | FTS5 over name/tags/OCR/provenance, query chips, saved searches and keyboard command/search center. | P1 | Transformative | Index migration, OCR jobs. |
| L2: scale (3–6 mo) | Persistent thumbnails, virtualization, content hashes, duplicate review, batch rename/export/tag/move and background jobs. | P1 | High | Performance/job service. |
| L3: relate (5–9 mo) | Versions/stacks, related captures, visual similarity and project/activity timelines. | P2 | High | Content hashes/vision. |
| L4: portable (6–18 mo) | Multiple roots, encrypted backup/export packages and optional conflict-safe sync. | P2/P3 | Transformative | Data identity/security model. |

## Implementation phases

Define stable artifact identity independent of path → migrate index → build
query engine/fixtures at 50k+ items → accessible virtualized UI → background
derived-data jobs → recovery/backup → optional visual intelligence. Search must
remain useful with models disabled.

## Success criteria

- Known capture found in <10 seconds in ≥90% of task tests; p95 query <150 ms at
  50k items.
- Import/reindex/trash interruption never loses an original or sidecar.
- Initial useful library paint <500 ms; scrolling has no user-visible jank and
  memory remains bounded at 100k items.
- Duplicate review safely reclaims space with preview, provenance and undo.
- Backup/restore round-trip preserves artifacts, labels, collections, scenes and
  provenance exactly.

## Risks and alternatives

- OCR/semantic indexing expands privacy/storage; make derived indexes local,
  bounded, clearable and independently rebuildable.
- Path-independent IDs ease moves/sync but are a significant migration; content
  hashes plus legacy path aliases can bridge gradually.
- Saved-rule builders can become complex; start with query chips and save the
  resulting query.

