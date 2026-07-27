# 0025 — Stamps are a bundled vector icon set, shared as path data both renderers fill

- **Status:** Accepted (implemented)
- **Date:** 2026-07-20
- **Area:** `app/frontend/src/features/editor/{lib/stamps.ts,components/SceneNodeView.tsx,lib/render.ts,components/panels/StampSection.tsx,components/InspectorSections.tsx,components/EditorCanvas.tsx,state/editorStore.ts,tools.ts,types.ts}`
- **Relates to:** [0023 — spotlight](0023-editor-spotlight-page-dim-overlay.md)
  (the "share the path itself, not the numbers" form this reuses),
  [0022 — window chrome](0022-editor-window-chrome-above-the-capture.md) (the
  shared-geometry-module contract, and the strokes-not-glyphs precedent),
  [0024 — measure](0024-editor-measure-is-a-line-with-a-derived-label.md) (the
  `exportBounds` trap this one is deliberately *not* in),
  [0010 — sample regions](0010-editor-sample-regions-blur-magnifier.md) (the
  "property on an existing node, not a new type" precedent),
  [0021 — multi-select](0021-editor-multi-select-edit-by-index.md) (how the panel
  batches), editor roadmap Workstream A / **Fork A-F4**,
  [editor-tools](../roadmaps/editor-tools.md)

## Context

A stamp — a single recognizable icon dropped on a capture: a check, a cross, a
warning triangle — is the **last gap in the annotation set**. Fork F4, spotlight,
the callout tail handle and measure all shipped before it, and
[vision-ai](../roadmaps/vision-ai.md) P6 (AI-assisted annotation) was explicitly
gated on the toolset being complete.

**Fork A-F4** asked: *a small bundled emoji/icon set, or user-supplied assets?*

Neither alternative survives contact with what the editor already has.
**User-supplied assets already ship** — an image node with a data-URI fill is
precisely "stamp your own PNG", complete with scale and align controls, so a
second path to the same place would have added a feature nobody gained.
And **emoji glyphs cannot hold the two-renderer invariant**: a glyph is
rasterized by whichever emoji font the *machine* has, so the same document would
export differently on two machines — and the SVG text layout and Canvas2D
`fillText` do not share metrics even on one. That is exactly why ADR 0022 drew
the Windows caption buttons as strokes rather than glyphs, and why Fork F1
recommends *bundled* fonts.

## Decision

**1. A stamp is a `stamp` property on a *rectangle* node.** `StampSpec {kind}` —
only which icon. The color is the node's `fills`, the halo its `strokes`, the
size its frame, so a stamp needs no controls beyond a picker. This is the
resolution every annotation before it reached (ADR 0010/0011/0022/0023/0024), and
the carrier is the rectangle because a stamp's defining geometry is *a box the
glyph is fit into*. `canCarryStamp` is `type === "rectangle"`, so a spec stranded
on any other type is inert rather than half-rendered.

**2. The drawings are vector path data this repo owns**, authored on a 24-unit
grid (Lucide's, so a stamp and the toolbar icon offering it share proportions)
and mapped into the node's box by `lib/stamps.ts`. **Cubics only, never `A`** —
an elliptical arc carries large-arc/sweep flags that are ambiguous at exactly
180° and radii the spec silently scales up when the endpoints don't fit, so an
`arc()` helper converts the arcs the icons want into cubics. The emitted string
then means exactly one thing in an SVG `d` and in a `Path2D`.

**3. Each renderer gets two `d` strings and decides only how to emit them** —
`fillD` (areas, filled even-odd so the pin's hole and the lock's keyhole read as
holes) and `strokeD` (lines, at the icon's own weight). This is the ADR 0023
form of the ADR 0022 contract: sharing the *path* rather than the numbers, which
is as tight as parity gets. `SceneNodeView`'s `StampMark` and `render.ts`'s
`drawStamp` are two spellings of one drawing.

**4. `fills` are the ink; `strokes` are a halo.** The node's strokes paint the
same two paths *underneath* at a widened weight (`stampHaloWeight` /
`stampOutlineWeight`) — the classic outlined-text trick, and what makes a mark
read on a busy screenshot. It also means the Stroke panel controls something real
on a stamp instead of sitting there inert. Stroke **align** has no meaning for a
halo (a glyph has no single inside) and is ignored by both renderers.

**5. The glyph is fit into the largest centered square of the frame, never
stretched.** The tool constrains the drag to a square as it's drawn, so in
practice the box *is* the frame; the fit is what makes a later non-uniform resize
harmless rather than something either renderer has to decide about.

**6. The picker is one control with two jobs.** `StampSection` shows for a
selection containing stamps *and* for the armed Stamp tool; choosing an icon
re-icons the selection **and** arms the next stamp, so there is no separate
"default icon" setting to fall out of sync. The session's choice reaches a new
node through `addNode`, the same seam a step badge gets its number from.

## Consequences

- **Parity verified by pixels, not by inspection.** Each of the twelve icons was
  rasterized from the live SVG and from `flattenScene`'s Canvas2D export at the
  same size and diffed: **zero differing pixels, max channel delta 0**, for all
  twelve. That is the invariant's strongest possible statement, and it follows
  from the two renderers consuming the same string.
- **No `exportBounds` change, and that is the point.** Chrome paints a bar
  *above* its node and a dimension hangs caps and a label off a zero-height
  segment, so both had to grow the export region (ADR 0022/0024). A stamp paints
  only *inside* its frame, so the node's own box already is its extent —
  confirmed on the harness: every icon's single-node export came out exactly
  64×64 for a 64×64 node. Likewise a stamp does **not** seal the page: it is a
  local mark like a callout, not a page-wide treatment like crop/backdrop/chrome/
  spotlight, so the export-region trap does not apply to it at all.
- **Effects apply to no stamp, in either renderer.** A drop shadow cast from the
  *box* silhouette behind a glyph is not what anyone means, so both renderers
  branch to the glyph before any effect is considered — `SceneNodeView` dispatches
  above `RectView`'s filter wrapper, `drawShape` returns before its shadow work.
  Line-like marks already behave this way. A halo covers the readability need
  that a shadow would otherwise serve.
- **Adding an icon is a one-place change.** A new entry in `lib/stamps.ts`'s
  catalog reaches both renderers and the picker (which previews through the same
  emitter), and `stampGeometry` falls back to the first icon for a `kind` outside
  the catalog, so a scene from a future version still draws something.
- **No keyboard shortcut.** The letter map has been full since Measure took `M`
  (ADR 0024), so Stamp joins pixelate/magnify/step/callout/spotlight on the
  annotate submenu only.
- **No backend work.** The spec is one string; ADR 0017's sidecar carries it.
- **Workstream A has no tool gap left**, which is the gate
  [vision-ai](../roadmaps/vision-ai.md) P6 was waiting on.

## Alternatives

- **Emoji glyphs (the literal reading of A-F4).** Rejected — the same document
  would export differently on two machines, and the two renderers' text metrics
  don't agree even on one. This is ADR 0022's strokes-not-glyphs argument.
- **User-supplied stamp assets.** Rejected as already shipped: that is an image
  node with a data-URI fill.
- **A dedicated stamp node type.** Rejected for the reason every annotation
  before it was: a property on an existing node inherits transform, selection,
  undo, and sidecar persistence, where a new type re-implements all four.
- **An SVG `d` in the icon's own space plus a shared transform.** Workable — both
  renderers can apply a translate+scale — but it puts a second thing (the
  transform) between the two branches, and stroke weights then live in a scaled
  space where a mistake is invisible until export. Emitting scene-space path data
  removes the question.
- **A path-data *parser*, so icons could be pasted from any SVG.** Rejected for
  this pass: a parser is the part most likely to disagree with a browser's own,
  which is the one thing this feature must not risk. The command-list catalog is
  authored, reviewable, and exact.
- **A browsable tray of many icons.** Rejected — the value of a stamp is that it
  reads instantly at 32 px, which is a property of the drawing, not the size of
  the menu. Twelve curated marks cover verdict, caution, emphasis, state and
  gesture.
- **A drop shadow instead of a halo for readability.** Rejected — it would need a
  glyph-silhouette shadow on the Canvas side to match the SVG filter, i.e. real
  divergence risk, for a worse result than an outline on a light screenshot.
