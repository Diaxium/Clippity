# 0019 — Crop resizes the page frame and absorbs stray roots

- **Status:** Accepted (implemented)
- **Date:** 2026-07-20
- **Area:** `app/frontend/src/features/editor/{lib/crop.ts,components/CropOverlay.tsx,components/EditorCanvas.tsx,state/editorStore.ts,tools.ts,types.ts,keybinds/editorKeybinds.ts}`
- **Relates to:** [0017 — editable save + grouping](0017-editor-editable-save-and-grouping.md)
  (frames as logical containers; the sidecar that persists the cropped page),
  editor roadmap Phase 2 / **Fork F4**, [editor-tools](../roadmaps/editor-tools.md)

## Context

Crop is the first half of Fork F4 ("crop + device frames — the *beautiful
screenshot* treatment"), the roadmap's top-ranked remaining editor item. Fork
F4's open recommendation was to model page treatment as **a frame/backdrop
property rather than a wrapper node**; crop is the first operation that forces
that question to be answered concretely.

Two facts about the existing scene decided it:

1. `sceneFromImage` already opens a capture as **one root frame** (clipping,
   sized to the bitmap) with the image as its child. That frame *is* the page —
   there was simply no operation that treated it as one.
2. Both renderers derive the document's extent from **`unionBounds` of the root
   nodes** — `render.flattenScene` for the exported bitmap, `zoomToFit` for the
   view. Nothing else defines "how big is this document".

Point 2 is the trap. Annotations do not reliably live *inside* the page frame:
`editorStore.frameAt` only reparents a new node when its centre lands within a
frame, so anything drawn past the image edge — plus anything pasted or
ungrouped — becomes a **sibling root** of the page. Shrinking the page frame
alone would therefore have left the exported image exactly the same size. The
crop would have looked right on canvas and done nothing to the output.

## Decision

**1. Crop resizes the page frame.** The page is `rootIds[0]`, and only when
that root is a frame. Committing patches its `{x, y, width, height}`. Children
keep their absolute scene coordinates and the frame's `clipContent` does the
trimming, so a crop is:

- **non-destructive** — no pixels are discarded; undo, or cropping back
  outward, restores everything;
- **one undo step** — a single `mutate`, taken on Apply only;
- **format-agnostic** — nothing touches image data, so it composes with the
  format-driven save of [ADR 0018](0018-export-format-carried-by-data-uri.md).

**2. Committing absorbs every other root into the page**, appended in their
existing order. This is what makes the crop mean something: with the page as
the sole root, `unionBounds` collapses to the crop rect, so the export region
*is* the crop and `clipContent` trims the overflow. The live SVG canvas and the
Canvas2D export agree **by construction — neither renderer changed**, which
matters because two-renderer parity is the program's load-bearing invariant.

Paint order is preserved exactly, and that is precisely why the page must be
`rootIds[0]`: as the backmost root its own children already painted before every
stray, so appending the strays after them reproduces the original sequence. A
document whose backmost root is not a frame has no well-defined page, so the
crop tool stays inert rather than guessing at an extent.

Commit also forces `clipContent: true` on the page, so a non-clipping frame
can't leave the canvas showing content the export will trim.

**3. Crop is a modal session, not a drawing tool.** `cropSession` holds the
pending rect off to the side of the document; the canvas routes every pointer
gesture into it and stops picking, marqueeing, drawing and double-click
selection while it is open. Entering and leaving both go through `setTool`, so
the tool and the session can never disagree, and opening clears the selection —
which additionally lets the `editor`-context `Enter` binding (Apply) resolve
over the `selection`-context `Enter` (edit text) without a conflict.

## Consequences

- The layer tree is restructured on the first crop of a document that had stray
  annotation roots. This is a real, visible change — but it moves the tree
  *toward* the shape it already has for anything drawn inside the image, and
  it's inside the same undo step.
- `pageFrameId` returning null (backmost root isn't a frame) silently disables
  crop. Reachable only by sending an annotation behind the page.
- The tool needs no backend work at all, matching the roadmap's assessment.
- Dragging a crop edge **outward** past the bitmap already produces page
  padding. That is deliberate: it's the substrate F4's second half (device
  frames / gradient backdrop / window chrome) paints into, so `lib/crop.ts` is
  really the *page* model with crop as its first operation.

## Alternatives

- **A wrapper "page" node** (the other side of Fork F4). Rejected: the seeded
  frame is already exactly that node; adding a second container would duplicate
  the concept and break every saved sidecar.
- **Teach `flattenScene` a page-aware region** instead of absorbing roots.
  Rejected: it makes the export disagree with the live canvas (strays would
  still render outside the page on screen but vanish from the output) — the
  parity invariant again — and it puts document-structure knowledge into a
  renderer.
- **Destructive crop** (resample the bitmap to the crop rect). Rejected: it
  throws away capture data, can't be undone losslessly after a save, and would
  force the crop through the backend for no benefit.
- **Clamping the crop to the image bounds.** Rejected: outward crop is the
  padding primitive F4's second half needs.
