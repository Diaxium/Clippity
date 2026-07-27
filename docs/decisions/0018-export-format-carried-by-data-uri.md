# 0018 — Export format is carried by the data URI; the backend is a byte-faithful sink

- **Status:** Accepted (implemented)
- **Date:** 2026-07-20
- **Area:** `app/backend/src/{domain/editor.rs,services/{capture_io,editor_service}.rs}`,
  `app/frontend/src/features/editor/{lib/render.ts,hooks/useEditorExport.ts,components/panels/ExportSection.tsx}`
- **Relates to:** [0017 — editable save + grouping](0017-editor-editable-save-and-grouping.md)
  (the same `editor_save` / `editor_load` surface), editor roadmap Phase 0,
  [Sharing P0](../roadmaps/sharing-export.md)

## Context

The editor could only export PNG. Both the editor roadmap (Phase 0) and the
sharing roadmap (P0) asked for JPG/WebP with a quality control, and both noted
it was *the same backend change — build once*.

The frontend already had the encoder: `canvas.toDataURL(mime, quality)` produces
PNG, JPEG and WebP. The backend did not. `domain::editor::extract_base64_png`
hard-matched the literal prefix `data:image/png;base64,` and
`capture_io::save_png` hard-coded the `.png` extension, so a JPEG data URI was
rejected outright.

The open question was **where the format lives**: a separate `format` argument
threaded through the IPC, or a property of the payload itself.

## Decision

**1. The data URI is the source of truth for the format.** `editor_save` takes
the same single `data_uri` argument it always did. A new pure
`domain::editor::parse_image_data_uri` splits it into an `ImageFormat` +
base64 payload; `ImageFormat::extension()` names the file on disk. There is no
`format` IPC parameter, because a payload that disagreed with its own declared
MIME would be unrepresentable-by-construction otherwise.

The accepted set is deliberately narrow — exactly PNG / JPEG / WebP, the three
a browser canvas is guaranteed to encode. `image/gif` is *rejected* even though
the library can hold GIFs, because the editor cannot produce one and writing
`.gif` over non-GIF bytes would mislabel the file.

**2. The backend never transcodes.** It writes the exact bytes the canvas
produced. All quality/compression decisions belong to the encoder that made
them. This keeps `editor_save` a dumb, fast sink and means adding a format is a
one-line change to `ImageFormat`, not a new Rust encode path.

**3. JPEG exports are matted onto white in the renderer.** JPEG has no alpha
channel, so a scene with transparent regions would otherwise come back with
those regions **black**. `flattenScene` fills the bitmap with `#ffffff` before
drawing when `formatIsOpaque(format)`. This lives in the frontend because that's
where the pixels exist — consistent with the program's rule that the backend
sees only baked pixels.

**4. Clipboard copy stays PNG unconditionally.** The async clipboard API only
accepts `image/png` for images, so `copyPng` forces the format rather than
honouring a lossy panel choice that would just fail at `ClipboardItem`.

**5. `capture_io` grew `save_image` / `save_capture_image` (extension-taking)**
with `save_png` / `save_capture_png` retained as thin wrappers. The four capture
pipelines (fullscreen, overlay, scroll, editor) keep their existing call shape;
only the editor passes a non-PNG extension today.

## Consequences

- **`editor_load` was declaring the wrong MIME.** It hard-coded
  `data:image/png;base64,` for *every* capture, so a `.jpg`/`.webp` file in the
  library was announced as PNG. Fixed via `editor::mime_for_path`, which also
  covers GIF/BMP on the read side (a wider set than the write side, on purpose)
  and falls back to PNG for unknown extensions — matching `library::kind_of`'s
  existing "unknown means image" precedent.
- **The library needed no changes.** Its scan lists any file and `kind_of`
  already mapped `jpg`/`jpeg`/`webp` to `CaptureKind::Image`; `thumbnail`
  decodes by extension and re-encodes to PNG regardless of the source format.
- **This path does not extend to SVG/PDF.** Neither has a `toDataURL` encoder,
  so the still-open vector export (Phase 3) is renderer work and will need its
  own mechanism — it does not simply add two more `ImageFormat` variants.
- **Format/quality are panel-local state**, like `scale` already was. The top
  bar, context menu and `Mod+E` therefore still export PNG. Promoting the
  choice into the scene document is noted as an open question in the roadmap.
- A browser that cannot encode the requested format silently returns PNG from
  `toDataURL`. That degrades correctly here *because* of decision 1: the data
  URI still declares what it actually is, so the file gets a `.png` extension
  rather than a mislabelled one.

## Alternatives

- **A `format` argument on the IPC.** Rejected: it can contradict the payload,
  and every caller would have to keep the two in sync.
- **Encode in Rust from raw pixels.** Rejected for the editor: the canvas has
  already rasterized the scene, so shipping RGBA to the backend to re-encode
  would double the work and the memory. (This *is* the right answer for capture
  pipelines, which hold an `RgbaImage` and never touch a canvas — that's why
  `save_capture_image` takes an extension rather than a data URI.)
- **Matte JPEG in the backend.** Rejected: it would force a decode →
  composite → re-encode round trip purely to undo a decision the renderer could
  have made for free, and it would violate decision 2.
- **A checkerboard or user-chosen matte colour.** Deferred — white is what a
  document/README/chat background almost always is. Worth revisiting alongside
  the "beautiful screenshot" backdrop work (Fork F4), which introduces a real
  page-background concept the matte should then follow.
