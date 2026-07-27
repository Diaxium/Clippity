# Architecture Decision Records

Numbered, append-only records of single load-bearing decisions for Clippity.
Broader, multi-decision planning lives in standalone docs (e.g. the
[roadmaps](../roadmaps/README.md), including the
[editor-improvement roadmap](../roadmaps/editor-improvement.md)).

Format: each file is `NNNN-kebab-title.md` with Status / Context / Decision /
Consequences / Alternatives. New decisions take the next free number.

## ⚠ Numbering gap: 0001–0008 were lost (2026-06-08)

A project-folder reorganization (the active project moved to
`A:\Personal\Apps\Clippity`; the separate `-legacy` project was removed) dropped
the entire `docs/` tree. ADRs **0001–0008 did not survive and are not
recoverable** — they predate the editor-improvement program's project memory, so
their text can't be reconstructed. The only one referenced elsewhere in the code
/ roadmap is **0006 — aux-catalog of saved colors & palettes** (named in the
properties-panel review); the rest are unknown by title.

ADRs **0009–0012** below were reconstructed on 2026-06-09 from the editor program
memory, which captured each decision in full. Numbering continues from 0013.

## Index

- 0009 — [Editor effects: inner shadow + spread](0009-editor-effects-inner-shadow-and-spread.md)
- 0010 — [Editor sample regions: blur + magnifier](0010-editor-sample-regions-blur-magnifier.md)
- 0011 — [Editor node blend modes](0011-editor-node-blend-modes.md)
- 0012 — [Editor pixelate sample regions](0012-editor-pixelate-sample-regions.md)
- 0013 — [Editor freeform gradients (raster IDW engine)](0013-editor-freeform-gradients.md)
- 0014 — [Editor mesh gradients (bilinear raster)](0014-editor-mesh-gradients.md)
- 0015 — [Annotation sample effects in Design mode, redaction removal, magnifier clip](0015-editor-annotation-effects-and-mode-cleanup.md)
- 0016 — [Centralized editor keybind system (Figma + Illustrator hybrid)](0016-editor-keybind-system.md)
- 0017 — [Editable scene save (JSON sidecar) + grouping via frames](0017-editor-editable-save-and-grouping.md)
- 0018 — [Export format carried by the data URI; backend is a byte-faithful sink](0018-export-format-carried-by-data-uri.md)
- 0019 — [Crop resizes the page frame and absorbs stray roots](0019-editor-crop-resizes-the-page-frame.md)
- 0020 — [The page backdrop is padding + the page frame's own fills](0020-editor-page-backdrop-from-existing-primitives.md)
- 0021 — [Multi-select edits list rows by index, and reads through three primitives](0021-editor-multi-select-edit-by-index.md)
- 0022 — [Window chrome is a bar above the capture, and one shared geometry module](0022-editor-window-chrome-above-the-capture.md)
- 0023 — [Spotlight is a page-dim scrim with the region punched out, and one shared even-odd path](0023-editor-spotlight-page-dim-overlay.md)
- 0024 — [A measurement is a property on a line node, and its number is derived, never stored](0024-editor-measure-is-a-line-with-a-derived-label.md)
- 0025 — [Stamps are a bundled vector icon set, shared as path data both renderers fill](0025-editor-stamps-are-bundled-vector-icons.md)
- 0026 — [Capture provenance is a sidecar, written once at the save choke point](0026-capture-provenance-is-a-sidecar-written-at-the-save-choke-point.md)
- 0027 — [The monitor is attributed, the preset is declared](0027-monitor-is-attributed-preset-is-declared.md)
- 0028 — [The library index is a SQLite cache, reconciled before every read](0028-library-index-is-a-cache-reconciled-before-every-read.md)
- 0029 — [Labels ride a sidecar; a collection is a document](0029-labels-are-a-sidecar-collections-are-a-document.md)
- 0030 — [Root-level pnpm + Cargo workspace restructure](0030-root-workspace-restructure.md)
- 0031 — [Recording encodes through Media Foundation; one session, two outputs](0031-recording-is-media-foundation-one-session-two-outputs.md)
