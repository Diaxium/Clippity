# 0010 — Editor sample regions: blur + magnifier

- **Status:** Accepted (implemented, Workstream A2)
- **Date:** 2026-06-04 · *reconstructed 2026-06-09 from program memory*
- **Area:** `app/frontend/src/features/editor` — both renderers
- **Extended by:** [0012 — pixelate sample regions](0012-editor-pixelate-sample-regions.md)

## Context

Snagit-style **Blur** and **Magnifier** annotation tools both need to re-display
the captured image, transformed, inside a region the user draws — blurred to
obscure, or zoomed as a loupe. The original roadmap Fork F3 proposed a dedicated
`SampleNode` type, but a new node type ripples through geometry, hit-testing,
the layer tree, selection, factories, and both renderers.

## Decision

Model a sample region as an **optional `sample?: SampleSpec { mode, amount }` on
`NodeBase`**, not a new node type. The region is an ordinary box —
**Blur = rectangle, Magnifier = ellipse** (with a loupe-ring stroke) — so move,
resize, rotate, hit-test, layers, and selection all treat it as a normal shape.
**Only the two renderers special-case `sample`.** This deliberately deviates
from Fork F3.

- **Base image** (`lib/sample.ts#findBaseImage`): the largest-area image node in
  the scene — robust for the common single-capture document.
- **Blur:** SVG `feGaussianBlur` scoped to the region (`filterUnits=
  userSpaceOnUse`) ↔ Canvas2D `ctx.filter = blur(amount)`, the **same σ** on both
  sides. The image is drawn "cover" and clipped to the region shape, so it stays
  aligned with the image beneath.
- **Magnify:** scale the base image about the region centre by `amount`, in both
  renderers; clipped to the ellipse, with a ring stroke.
- Implemented in `SceneNodeView` (`SampledImage`) and `render.ts` (`drawSample`).
- `SampleSection` panel edits the `amount` (blur px / zoom ×).

## Consequences

- No ripple: the whole interaction/layout/selection stack is unchanged.
- A sample region reflects the **capture (base image)**, not other annotations
  beneath it — deliberate and Snagit-like (you blur/magnify the screenshot; your
  markup stays crisp).
- **Pixelate** was modelled (`SampleMode = "blur" | "pixelate" | "magnify"`) but
  deferred to A2.1 — SVG has no reliable native mosaic filter (see ADR 0012).
- Pixel output isn't unit-testable in jsdom; tests cover the factory, the
  base-image lookup, the SVG sample structure, and the panel.

## Alternatives considered

- **Dedicated `SampleNode` type (Fork F3)** — rejected; node-type ripple.
- **CSS `backdrop-filter`** — rejected; not reproducible in the Canvas2D export.
