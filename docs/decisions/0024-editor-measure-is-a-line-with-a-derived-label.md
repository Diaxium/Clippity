# 0024 — A measurement is a property on a line node, and its number is derived, never stored

- **Status:** Accepted (implemented)
- **Date:** 2026-07-20
- **Area:** `app/frontend/src/features/editor/{lib/measure.ts,lib/paint.ts,components/SceneNodeView.tsx,lib/render.ts,components/panels/MeasureSection.tsx,components/EditorCanvas.tsx,tools.ts,types.ts}`
- **Relates to:** [0022 — window chrome](0022-editor-window-chrome-above-the-capture.md) and
  [0023 — spotlight](0023-editor-spotlight-page-dim-overlay.md)
  (the shared-geometry-module pattern this reuses, and the `exportBounds` trap it
  reaches a second way), [0010 — sample regions](0010-editor-sample-regions-blur-magnifier.md)
  and [0011 — node blend modes](0011-editor-node-blend-modes.md) (the
  "property on an existing node, not a new type" precedent),
  [0021 — multi-select](0021-editor-multi-select-edit-by-index.md) (how the panel
  batches), editor roadmap Workstream A / **Fork A-F3**,
  [editor-tools](../roadmaps/editor-tools.md)

## Context

A measurement — a dimension line with end caps and a label reading the distance
between its two points — is one of the two gaps left in the annotation set after
Fork F4, spotlight, and the callout tail handle shipped. It is the mark you reach
for when a screenshot is the subject of a spec review: "this gutter is 24 px",
"the card is 320 wide".

**Fork A-F3** asked whether it should be a *persistent dimension node* or a
*transient readout* (a HUD that appears while you drag and vanishes on release).
Two things settle it for the persistent form. A transient readout can't be saved,
exported, restyled, or re-read later, so it never reaches the exported PNG — and
the exported PNG is the entire product. And a readout would be a fourth
measuring surface beside the ones the editor already has (the TransformHud, the
rulers, the position panel), which is the situation Workstream M was created to
stop.

## Decision

**1. A measurement is a `measure` property on a *line* node, not a new node
type.** A `MeasureSpec {caps, scale, unit}` on a line makes its two endpoints the
two points being measured. This is the resolution every annotation before it
reached — blur/pixelate/magnify are a `sample` (ADR 0010), highlight is a
`blendMode` (ADR 0011), callouts a `callout`, spotlight a `spotlight`, chrome a
`chrome` — but the *carrier* is chosen differently here for a reason: every prior
annotation hung off a box shape, and a dimension's defining property is that it
has two ends. The line node already models exactly that (signed width/height
encode the a→b vector), so the mark inherits endpoint handles, 45°-constrained
drawing, marquee selection, nudge, undo, and ADR 0017 sidecar round-trip for
free. `canCarryMeasure` is `isLineLike`, so a spec stranded on any other type is
inert rather than half-rendered.

**2. The number is derived from the geometry, never stored.** Scene space is
capture px at 1:1 (`sceneFromImage` sizes the page to the bitmap), so the
distance between the endpoints *is* the measurement; `measureGeometry` recomputes
it every render. Storing it alongside would make the line and its label two
sources of truth that disagree the instant either endpoint moves — and moving an
endpoint is the primary way you use this tool. `scale` and `unit` only
re-express that one true length (a 2× capture read in logical px, a known
reference read in mm), which is why the panel deliberately offers **no length
field**: a typable number would reintroduce exactly the disagreement this avoids.

**3. One shared geometry module, `lib/measure.ts`, hands both renderers the
whole drawing as data.** A dimension paints things that live *outside* the line —
perpendicular serifs, arrowheads, and a rotated label pill sitting in a break in
the shaft — and no primitive either renderer already reads can express that. Same
position window chrome and the spotlight scrim were in, same answer:
`measureGeometry(node)` returns the shaft segments, the caps, the filled heads,
and the label's placement, and each renderer only decides how to *emit* it
(`<line>`/`<polygon>`/`<rect>`+`<text>` vs `stroke`/`fill`/`fillText`).
`SceneNodeView`'s `MeasureMarks` and `render.ts`'s `drawMeasure` are two
spellings of one drawing.

**4. The label's pill is sized here, and both renderers center text inside
it.** The number is the point of the feature, so unlike ADR 0022's caption
buttons this mark cannot avoid text. What it *can* avoid is two independent text
measurements: the pill is sized from a mean advance width in this module, and
both renderers center the string in that same rect. A pill that is slightly loose
is fine; a pill that differs between the live canvas and the export would not be
— and the Canvas2D path can't be unit-tested at all (jsdom has no 2D context), so
the divergence would ship unseen.

**5. The mark's whole appearance comes from the node's own stroke.** Shaft, caps,
and the label pill all take the top visible stroke's color, width, and opacity;
the label's ink is contrast-picked against it. So the existing Stroke section
recolors and reweights the dimension with no new controls, and the label reads on
any capture without a second color to keep in sync. The luminance rule moved out
of `lib/chrome.ts` into `lib/paint.ts` as `readableInk` — chrome's bar and this
pill need the same answer for the same reason, and `chromeInk` now delegates.

**6. The panel offers caps, scale, and unit,** batching through `updateEach`
(ADR 0021) so a multi-selection restyles together while each dimension keeps the
rest of its own spec. It also reports the primary's raw capture-pixel reading, so
a scaled dimension still says what it actually measured.

## The export-region trap, reached a second way

ADR 0022 found that `rotatedAABB` measures a node's *frame*, so exporting a
chromed capture on its own sliced the title bar off, and fixed it with
`exportBounds`. A dimension reaches the same trap from the opposite direction and
much harder: **a horizontal line's frame is zero-height**, while its serifs and
label pill hang entirely off it. Exporting one on its own would have produced a
1px-tall strip containing nothing.

`exportBounds` now unions in `measureBounds(node)` — the decoration's true extent
— alongside the chrome case. Verified against the running editor on the smoke
harness with an 810px dimension:

```
rotatedAABB:     810 × 0        ← the node's own frame
exportBounds:    812 × 20.24    ← caps + label included
```

Deliberately still not folded into `rotatedAABB` itself, for ADR 0022's reason:
that function also backs selection chrome, hit-testing and zoom-to-selection,
where the node's own segment is the right answer.

Note that a measurement does **not** seal the page, unlike crop/backdrop/chrome/
spotlight. Those four either resize the page or paint across it, so the page rect
has to be the document extent for them to be correct. A dimension is a local mark
like a callout or a step badge; sealing on it would be a surprising tree
restructure for no gain.

## Two-renderer parity

Verified on the smoke harness by flattening the same node through the Canvas2D
export and probing pixels, since that is where this editor's real bugs hide:

```
on the rule (400,690):                 #f24822   ← shaft drawn
in the shaft's gap, outside the pill:  transparent  ← shaft genuinely broken
the right-hand serif (1070,686):       #f24822   ← tick cap drawn
past the right tick (1075,690):        transparent
near-white pixels inside the mark:     98        ← the number rendered
```

Switching to arrow caps removes the serif (`transparent` where it was) and puts a
filled barb inside the tip, matching the live SVG. A back-to-front diagonal
reports `456.5 px` with the label at `rotate(28.81…)` — the raw −151° flipped by
180° so the number never reads upside down.

## Consequences

- Both renderers gained one branch, held together by the shared module — the
  ADR 0022 cost, paid a third time for the third feature that warranted it.
- A dimension **replaces** the plain line rendering rather than decorating it,
  because its shaft is broken around the label and inset for arrow caps. An
  arrow node carrying a measure therefore draws dimension arrowheads, not the
  arrow node's own — one head style, not two overlapping.
- A dimension too short to have a direction (< 0.5 px) renders as nothing rather
  than as NaN, and a dimension whose strokes were all deleted falls back to a
  visible default rather than vanishing with no way back.
- `scale` is clamped on read, so a hand-edited sidecar can't report a nonsense
  length or blow the label pill past the page.
- Stored as a plain optional field, so ADR 0017's sidecars round-trip it with
  **no migration** — an older sidecar simply has no `measure`.
- `M` was the one unbound letter in the keybind map, and Illustrator's `M` is its
  rectangle, which Clippity already binds to `R` — so the tool takes it with no
  conflict and no deviation to document.
- No backend work.

## Alternatives

- **A transient readout instead of a node.** Rejected — see Context: it can't
  reach the exported image, which is the product.
- **A dedicated dimension node type.** Rejected for the reason every annotation
  before it was: a property on an existing node inherits transform, selection,
  undo, and persistence, where a new type re-implements all four. Here it also
  inherits endpoint dragging, which *is* the editing model for a dimension.
- **A `measure` on a box shape, measuring its width/height.** Tempting (it would
  reuse the box carrier every other annotation uses) but wrong: the thing being
  measured is usually a gap *between* two elements, which no single box frames.
  A line addresses any two points.
- **Storing the measured length in the spec.** Rejected — two sources of truth
  that disagree the moment an endpoint moves. See Decision 2.
- **Extension lines from the measured objects to the dimension line.** The full
  drafting convention, but it needs an anchor relationship between nodes that the
  scene graph doesn't model, and a screenshot has no "objects" to anchor to. The
  caps carry the same information.
- **The label offset beside the shaft rather than breaking it.** Workable, and
  what Figma's measure overlay does — but it covers content *next to* the line
  instead of the line itself, which is worse on a dense screenshot. Breaking the
  shaft is the drafting convention and keeps the mark inside its own corridor.
- **Sharing one path per renderer (the ADR 0023 refinement).** Not available: the
  mark is strokes of differing widths, filled triangles, a pill, and text — not
  one fillable region. Sharing the numbers is as tight as this one gets.
