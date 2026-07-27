# Feature roadmap

## Current state

Clippity already supports still capture, five region methods, object selection,
multi-area, clipboard ingest, color/palette, OCR, scrolling/panoramic capture,
provenance, library organization, a layered editor, presets and quick tray
actions. Partially built promises include recording, change detection, asset
extraction, richer sharing, advanced settings and cross-platform parity.

## Strengths to preserve

- Local-first capture and intelligence.
- Unusually rich selection and annotation toolset.
- One save choke point with provenance and reusable typed capture requests.
- Presets/tray as a natural base for automation.

## Problems and missed opportunities

- Users cannot import arbitrary media through a first-class workflow.
- Presets cannot express most custom modes or output pipelines.
- Video/GIF categories exist without a recorder.
- Captures are assets, but the product does little to help users reuse knowledge
  inside them.
- Reversible post-capture actions, batch operations and export destinations are
  underdeveloped.

## Initiatives

| ID | Class | Recommendation | Priority | Impact | Complexity | Dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | Quick win | Import/open-with/drag-drop for images, GIFs and videos; recent-file entry; paste from clipboard everywhere sensible. | P1 | High | M | Library ingestion, file validation. |
| F2 | Quick win | Result actions: copy, edit, pin, tag, move to collection, reveal, retry and undo/delete from one consistent surface. | P1 | High | M | Canonical result event, toast/UX. |
| F3 | Foundation | Evolve presets into versioned recipes supporting every capture mode, effects, naming, export format, destination and error policy. | P1 | Transformative | L | Architecture/job model, security. |
| F4 | Major | Screen recorder: region/window/fullscreen, mic/system audio, cursor emphasis, pause, trim, MP4/WebM/GIF and optimized presets. | P1 | Transformative | XL | Media backend, recorder screens, tests/perf. |
| F5 | Major | Smart library: OCR full-text search, provenance filters, saved searches, duplicates, related captures and batch tools. | P1 | High | L | FTS/index, privacy, migrations. |
| F6 | Major | Change Detection with before/after pairing, alignment, visual diff, threshold controls and history. | P2 | High | L | Capture provenance, editor diff layer. |
| F7 | Major | Narrative Mode: arrange captures into numbered steps, auto-callouts and export to Markdown/HTML/PDF/GIF. | P2 | High | XL | Editor/pages, documents/export. |
| F8 | Experiment | Live Lens: inspect text, colors, spacing and UI elements under the cursor; copy structured tokens/CSS. | P3 | High | XL | Vision/OCR, overlay accessibility. |
| F9 | Experiment | Temporary capture shelf: pin multiple ephemeral captures, drag between apps and auto-expire. | P3 | High | L | Retention/privacy, new utility window. |

## Milestones and implementation phases

- **Short term:** F1–F2, truthful unavailable states, custom-mode presets and
  duplicate/export preset controls.
- **Mid term:** F3–F5 with a recorder beta behind Labs and migration-safe recipe
  schema.
- **Long term:** F6–F9, promoted only after workflow-specific adoption tests.

For every feature: discovery prototype → domain contract/data migration →
accessible screens and errors → native implementation → instrumentation and
performance budget → documentation and release cohort → general availability.

## Success criteria

- ≥70% of first sessions produce and use an output (copy/export/share).
- ≥25% of weekly users run a recipe; repeated workflow actions fall by 50%.
- Recorder success ≥99%, A/V sync drift <100 ms over 30 minutes and no lost
  recording after a recoverable stop/crash.
- Search finds a known capture in <10 seconds in moderated tests; p95 query
  latency <150 ms at 50k items.
- Each experimental feature reaches ≥15% repeat use in its enrolled cohort
  before promotion.

## Risks, tradeoffs and alternatives

- Feature breadth can bury the fast-capture core; progressively disclose tools
  and let users customize the hub/tray.
- Recording may dominate platform work; a Windows-first beta with explicit
  capability matrix is preferable to false parity.
- Smart features can feel invasive; keep processing local by default and show
  exactly when a model/network action occurs.
- Recipes can become a programming language; start with a linear step builder
  and add conditions only from observed demand.

