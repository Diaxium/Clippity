# 0020 — The page backdrop is padding + the page frame's own fills

- **Status:** Accepted (implemented)
- **Date:** 2026-07-20
- **Area:** `app/frontend/src/features/editor/{lib/page.ts,components/panels/BackdropSection.tsx,components/InspectorSections.tsx,state/editorStore.ts,lib/sample.ts}`
- **Relates to:** [0019 — crop resizes the page frame](0019-editor-crop-resizes-the-page-frame.md)
  (the page model this builds on), [0017 — editable save + grouping](0017-editor-editable-save-and-grouping.md)
  (the sidecar that persists it), editor roadmap Phase 2 / **Fork F4**,
  [editor-tools](../roadmaps/editor-tools.md), [sharing-export](../roadmaps/sharing-export.md) P2

## Context

Device frames / backdrop is the second half of Fork F4 — the "beautiful
screenshot" treatment, and the roadmap's highest-ranked remaining editor item.
ADR 0019 settled the model half of the fork (**the seeded page frame *is* the
page**; padding and backdrop are properties of it, not a wrapper node) and left
a deliberate substrate behind: dragging a crop edge *outward* past the bitmap
already produces page padding. What remained was painting into it.

The temptation with a feature named "device frames" is to add a node type, or a
`PageSpec`, or a chrome renderer. Three facts about the existing scene argued
against all of that:

1. **Both renderers already paint a frame's `fills` beneath its children.**
   `FrameView` emits `<Fills>` before the clipped children group; `drawNode`
   calls `drawShape` before recursing. Every fill type — solid, all four
   gradients, image — therefore already works as a backdrop.
2. **Both renderers already draw `cornerRadius` and a drop-shadow `Effect`** on
   the capture's image node.
3. **The page frame clips its children**, so a shadow on the capture is visible
   exactly when there is padding for it to fall into.

So the entire feature is reachable by writing fields both renderers already
read. That matters more than convenience: two-renderer parity is the program's
load-bearing invariant, and the cheapest way to guarantee it is to change
neither renderer.

## Decision

**1. Padding is derived, never stored.** It is the gap between the page frame's
rect and the capture's rect — exactly what an outward crop creates. Writing it
re-derives the page rect from the capture (`paddedPageRect`); reading it
measures the gap back (`pagePadding`). Consequences of storing nothing:

- no new field to migrate in saved sidecars (ADR 0017's JSON is unchanged);
- no second source of truth that can disagree with the rect;
- crop and padding compose for free, because **they are the same edit**.

`pagePadding` returns the *minimum* of the four gaps, not one side's. After an
asymmetric crop the four differ, and only the smallest is padding on every
side; writing back then re-normalizes all four, so the field converges rather
than drifting.

**2. The backdrop is the page frame's `fills`.** `BACKDROP_PRESETS` is a menu of
stock paints, nothing more. A preset's identity is matched on the *painted
result* (`matchBackdropPreset`), not a stored id, so editing a backdrop through
the existing Fill popover honestly clears the panel's selection instead of
keeping a stale highlight.

**3. The content treatment is the capture node's `cornerRadius` + a drop-shadow
`Effect`,** tuned larger and softer than the generic `makeShadow()` the Effects
panel adds — a screenshot floating on a backdrop needs a lift, which reads at a
much bigger blur than a crisp UI-element shadow.

**4. Applying a backdrop to an unpadded page also opens a default margin** (and
rounds the capture's corners) in the *same* undo step. Without it the backdrop
is entirely hidden behind the capture, and the preset reads as a no-op.

**5. Padding and a non-empty backdrop both "seal" the page** — absorbing stray
roots into it via ADR 0019's existing `absorbRootsIntoPage`. See below; this is
the non-obvious part.

**6. The panel is document-scoped, not selection-scoped.** `BackdropSection`
renders on an *empty selection* or when the page frame itself is selected — the
page is what you have selected when you have nothing selected, the way Figma
surfaces canvas background. This also solves an Annotation-mode problem: the
Layers rail is hidden there (Workstream M2), so reaching the page frame's fills
by selecting it isn't practical, but pressing Escape is. A freshly-opened
capture already selects the page frame (`sceneFromImage`), so the controls are
present the moment a capture opens.

## Why sealing the page is required (the export-region trap)

This was found empirically against the running editor, not by reading code, and
it is the same trap ADR 0019 documents for crop — reached from a new direction.

Both renderers size the output from `unionBounds` of the **root** nodes, and
annotations do not reliably live inside the page: `frameAt` only reparents a new
node when its centre lands within a frame, so anything drawn past the image
edge, pasted, or ungrouped becomes a *sibling root*. With a 48px backdrop
applied to a scene whose arrow had been dragged past the right edge, the
measured result was:

```
page rect:     x -48 … 1148
export region: x -48 … 1250     ← unionBounds, stretched by the stray
```

The backdrop is the page frame's *fill*, so it covers the page rect and no
further. That 102px overhang would have exported as an **unpainted band** down
the right side — a gradient backdrop on three sides and raw transparency on the
fourth. The bug is invisible on screen (the stray renders fine over nothing) and
only appears in the saved file, which is the worst possible failure mode.

Absorbing the strays collapses the union back onto the page rect, exactly as
`commitCrop` does, and re-measuring confirms `exportRegion === pageRect`. Paint
order is preserved for ADR 0019's reason: the page is the backmost root, so its
children already painted before every stray, and appending the strays keeps the
sequence.

Clearing the backdrop to **None** deliberately does *not* seal — with no fill
there is nothing to leave a gap, and restructuring the layer tree on the way
back to a transparent page would be a surprising side effect of clearing a
color.

## Consequences

- **Neither renderer changed.** Parity holds by construction, as with crop.
- Padding is non-destructive and one undo step, inheriting both properties from
  the page-rect model rather than re-implementing them.
- The first padding/backdrop edit on a document with stray annotation roots
  restructures the layer tree. Real and visible, but identical to what the
  first crop already does, and inside the same undo step.
- `findBaseImage` now also returns the node **id** (`lib/sample.ts`). The page
  model needs to know *which node* the capture is, and re-deriving that
  independently would let the page model and the renderers disagree about what
  the document is a picture of.
- A "Corners" field only appears when the capture can carry a radius —
  `findBaseImage` keys on the fill, so an ellipse could in principle be the
  capture.
- No backend work, as the roadmap predicted for this fork.

## Alternatives

- **A `PageSpec` / `padding` field on the frame.** Rejected: a second source of
  truth for a rect that already exists, needing sidecar migration, and it would
  have to be kept in sync with crop — which edits the same rect by other means.
- **A wrapper "backdrop" node behind the page.** Rejected for ADR 0019's reason:
  the seeded frame is already that node, and a second container duplicates the
  concept and breaks saved sidecars.
- **Teaching `flattenScene` to export the page rect** instead of sealing.
  Rejected again: it makes the export disagree with the live canvas and puts
  document-structure knowledge in a renderer.
- **Rasterizing the backdrop into the capture bitmap.** Rejected: destructive,
  un-editable after save, and it would force the feature through the backend
  for no benefit.
- **Shipping window chrome in the same pass.** Deferred, not rejected — see
  below. It is the one part of F4 that genuinely cannot reuse an existing
  primitive, and bundling it would have put a new two-renderer code path inside
  a change whose entire value is not having one.

## Not included: window chrome

The remaining slice of Fork F4. Unlike padding and backdrop, a title bar with
traffic lights has **no existing primitive** — it needs a spec property on the
capture node, geometry, and a branch in *both* renderers, following the
precedent `step` and `callout` already set. Tracked in
[editor-tools](../roadmaps/editor-tools.md); it is a self-contained session's
work and is not blocked by anything here.
